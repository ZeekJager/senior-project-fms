import type { QueryResult, QueryResultRow } from 'pg';
import type { DependencyState } from '../cache/cache';
import type { Queryable } from './queryable';

/**
 * How fresh a response's data is (FMS-94): which database answered, and how far it was behind the primary.
 * Reporting endpoints return it as `meta.data_freshness`.
 */
export interface DataFreshness {
  source: 'replica' | 'primary';
  /** How far the data may be behind the primary's, whole seconds; 0 from the primary. */
  lag_seconds: number;
  /** The data is at least this current: now less the lag. */
  as_of: string;
}

/** A request's reads: one database for all of them, so the request sees one consistent point in time. */
export interface ReadSession extends Queryable {
  freshness(): DataFreshness;
}

export interface ReadRouterOptions {
  /** Further behind than this, sessions read the primary. */
  maxLagSeconds: number;
  /** How long a replica status is trusted before the next session checks again. */
  checkEveryMs?: number;
  /** After a connection failure, how long sessions go to the primary without trying the replica. */
  retryAfterMs?: number;
  log?: { warn(obj: object, msg: string): void };
  now?: () => number;
}

/** The replica's lag: 0 when it has replayed everything it received; otherwise since the last transaction it replayed. */
const LAG_SQL = `SELECT pg_is_in_recovery() AS standby,
  CASE WHEN NOT pg_is_in_recovery() OR pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
       ELSE COALESCE(EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()), 0) END::float8 AS lag`;

/**
 * Errors that say the replica cannot serve, rather than that the query is wrong: a connection that cannot be made
 * or was lost (class 08, the node errors), a server shutting down or starting (57P01-57P03), no free connection
 * (53300), and a standby query cancelled by recovery (40001). A query on the primary would run; anything else
 * (a syntax error, a constraint) would fail there too, so it is not retried.
 */
export function isReplicaUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (typeof e.code === 'string') {
    if (e.code.startsWith('08') || ['57P01', '57P02', '57P03', '53300', '40001'].includes(e.code)) return true;
    if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'EPIPE'].includes(e.code)) return true;
  }
  return /Connection terminated|timeout exceeded when trying to connect|connect ETIMEDOUT/i.test(e.message ?? '');
}

type Status = { kind: 'disabled' } | { kind: 'up'; lagSeconds: number; checkedAt: number } | { kind: 'lagging'; lagSeconds: number; checkedAt: number } | { kind: 'down'; until: number; reason: string };

/**
 * Read routing (FMS-94, §18, Scenario D): reporting reads go to the read replica, so heavy queries never slow the
 * primary's writes. Each request takes a session; the session reads the replica when it is up and close enough,
 * the primary otherwise, and says which in `freshness()`. A replica that fails mid-request hands the rest of the
 * request to the primary. Without a replica (`replica` null: development, tests) every session is the primary.
 */
export class ReadRouter {
  private status: Status;
  private fallbacks = 0;
  private readonly checkEveryMs: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly primary: Queryable,
    private readonly replica: Queryable | null,
    private readonly options: ReadRouterOptions,
  ) {
    this.status = replica ? { kind: 'down', until: 0, reason: 'not checked yet' } : { kind: 'disabled' };
    this.checkEveryMs = options.checkEveryMs ?? 5_000;
    this.retryAfterMs = options.retryAfterMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** A session for one request's reads. Checks the replica first when its status is older than `checkEveryMs`. */
  async session(): Promise<ReadSession> {
    await this.refreshIfStale();
    const status = this.status;
    if (status.kind === 'up') return this.replicaSession(status.lagSeconds);
    if (status.kind !== 'disabled') this.fallbacks += 1;
    return this.primarySession();
  }

  /** For readiness: `disabled` without a replica, `degraded` when sessions read the primary instead. */
  state(): DependencyState {
    if (this.status.kind === 'disabled') return 'disabled';
    return this.status.kind === 'up' ? 'ok' : 'degraded';
  }

  /** For readiness: checks now; rejects when the replica is down or too far behind. */
  async ping(): Promise<void> {
    await this.check();
    const status = this.status;
    if (status.kind === 'down') throw new Error(`read replica unavailable: ${status.reason}`);
    if (status.kind === 'lagging') throw new Error(`read replica ${status.lagSeconds} s behind`);
  }

  /** For readiness metrics: the last lag measured (-1 when unknown), whether reads use it, sessions sent to the primary instead. */
  async metrics(): Promise<Record<string, number>> {
    const status = this.status;
    const lag = status.kind === 'up' || status.kind === 'lagging' ? status.lagSeconds : -1;
    return { lag_seconds: lag, in_use: status.kind === 'up' ? 1 : 0, max_lag_seconds: this.options.maxLagSeconds, fallbacks: this.fallbacks };
  }

  private async refreshIfStale(): Promise<void> {
    const status = this.status;
    const at = this.now();
    if (status.kind === 'disabled') return;
    if (status.kind === 'down' && at < status.until) return;
    if ((status.kind === 'up' || status.kind === 'lagging') && at - status.checkedAt < this.checkEveryMs) return;
    await this.check();
  }

  /** One lag query on the replica; concurrent sessions share it. */
  private check(): Promise<void> {
    if (!this.replica) return Promise.resolve();
    this.checking ??= this.measure().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async measure(): Promise<void> {
    try {
      const res = await this.replica!.query<{ standby: boolean; lag: number }>(LAG_SQL);
      const lagSeconds = Math.max(0, Math.round(res.rows[0].lag));
      const kind = lagSeconds > this.options.maxLagSeconds ? 'lagging' : 'up';
      if (kind === 'lagging' && this.status.kind !== 'lagging') {
        this.options.log?.warn({ lagSeconds, maxLagSeconds: this.options.maxLagSeconds }, 'read replica too far behind: reading the primary');
      }
      this.status = { kind, lagSeconds, checkedAt: this.now() };
    } catch (err) {
      this.markDown(err);
    }
  }

  private markDown(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    if (this.status.kind !== 'down' || this.status.reason === 'not checked yet') {
      this.options.log?.warn({ err }, 'read replica unavailable: reading the primary');
    }
    this.status = { kind: 'down', until: this.now() + this.retryAfterMs, reason };
  }

  private primarySession(): ReadSession {
    const primary = this.primary;
    return {
      query: <R extends QueryResultRow>(text: string, values?: unknown[]) => primary.query<R>(text, values),
      freshness: () => ({ source: 'primary', lag_seconds: 0, as_of: new Date(this.now()).toISOString() }),
    };
  }

  private replicaSession(lagSeconds: number): ReadSession {
    let onPrimary = false;
    let answered = false;
    const query = async <R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> => {
      if (!onPrimary) {
        try {
          const res = await this.replica!.query<R>(text, values);
          answered = true;
          return res;
        } catch (err) {
          if (!isReplicaUnavailable(err)) throw err;
          // The rest of this request reads the primary, and so do the next ones until the replica answers again.
          this.markDown(err);
          this.fallbacks += 1;
          onPrimary = true;
        }
      }
      return this.primary.query<R>(text, values);
    };
    return {
      query,
      // A request that read the replica before it failed holds data as old as the replica's: it keeps that lag.
      freshness: () => {
        const lag = !onPrimary || answered ? lagSeconds : 0;
        return { source: onPrimary ? 'primary' : 'replica', lag_seconds: lag, as_of: new Date(this.now() - lag * 1000).toISOString() };
      },
    };
  }
}
