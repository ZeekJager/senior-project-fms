import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { Run, Sample, SampleStatus } from '../domain/health';

/** One minute's requests, as the middleware counted them on one instance. */
export interface RequestMinute {
  minute: Date;
  requests: number;
  errors5xx: number;
  latencyBuckets: number[];
}

/** A cell of a window's request rollups: its index from the window's start. */
export interface RequestCell {
  index: number;
  requests: number;
  errors5xx: number;
  latencyBuckets: number[];
}

export interface LatestSample extends Sample {
  minute: Date;
}

/** system.health_samples and system.request_rollups (FMS-143). Counts and our own error words only. */
export class HealthRepository {
  /**
   * One minute's samples. Instances each sample the same minute: the first row stands, unless a later one
   * found the component down, which wins (down on one instance is down for its requests).
   */
  async insertSamples(db: Queryable, minute: Date, samples: readonly Sample[]): Promise<void> {
    if (samples.length === 0) return;
    await db.query(
      `INSERT INTO system.health_samples (component, minute, label, status, latency_ms, error)
       SELECT component, $1, label, status, latency_ms, error
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[]) AS s(component, label, status, latency_ms, error)
       ON CONFLICT (component, minute) DO UPDATE
          SET status = EXCLUDED.status, latency_ms = EXCLUDED.latency_ms, error = EXCLUDED.error, label = EXCLUDED.label
        WHERE EXCLUDED.status = 'down' AND system.health_samples.status <> 'down'`,
      [
        minute,
        samples.map((s) => s.component),
        samples.map((s) => s.label),
        samples.map((s) => s.status),
        samples.map((s) => s.latencyMs),
        samples.map((s) => s.error),
      ],
    );
  }

  /**
   * Each component's runs since `from`: consecutive minutes with the same status (gaps-and-islands: within a
   * component and status, consecutive minutes keep `minute - row_number` constant), with the run's first error.
   */
  async runs(db: Queryable, from: Date): Promise<Run[]> {
    const res = await db.query<{
      component: string;
      label: string;
      status: SampleStatus;
      start: Date;
      end: Date;
      error: string | null;
    }>(
      `SELECT component, max(label) AS label, status, min(minute) AS start, max(minute) + interval '1 minute' AS "end",
              (array_agg(error ORDER BY minute) FILTER (WHERE error IS NOT NULL))[1] AS error
         FROM (SELECT component, label, status, minute, error,
                      minute - row_number() OVER (PARTITION BY component, status ORDER BY minute) * interval '1 minute' AS island
                 FROM system.health_samples
                WHERE minute >= $1) s
        GROUP BY component, status, island
        ORDER BY component, start`,
      [from],
    );
    return res.rows;
  }

  /** Each component's newest sample since `from`, with its label as it is now. */
  async latest(db: Queryable, from: Date): Promise<LatestSample[]> {
    const res = await db.query<LatestSample>(
      `SELECT DISTINCT ON (component) component, label, minute, status, latency_ms AS "latencyMs", error
         FROM system.health_samples
        WHERE minute >= $1
        ORDER BY component, minute DESC`,
      [from],
    );
    return res.rows;
  }

  /** Adds one instance's counts to the minutes' rows, bucket by bucket. */
  async addRequests(db: Queryable, minutes: readonly RequestMinute[]): Promise<void> {
    for (const m of minutes) {
      await db.query(
        `INSERT INTO system.request_rollups AS r (minute, requests, errors_5xx, latency_buckets) VALUES ($1, $2, $3, $4)
         ON CONFLICT (minute) DO UPDATE
            SET requests = r.requests + EXCLUDED.requests,
                errors_5xx = r.errors_5xx + EXCLUDED.errors_5xx,
                latency_buckets = ARRAY(SELECT COALESCE(a, 0) + COALESCE(b, 0) FROM unnest(r.latency_buckets, EXCLUDED.latency_buckets) AS t(a, b))`,
        [m.minute, m.requests, m.errors5xx, m.latencyBuckets],
      );
    }
  }

  /** The rollups of [from, to) added up per cell of `bucketMinutes`, cell 0 starting at `from`. */
  async requestCells(db: Queryable, from: Date, to: Date, bucketMinutes: number): Promise<RequestCell[]> {
    const res = await db.query<RequestCell>(
      `WITH r AS (
         SELECT floor(extract(epoch FROM minute - $1::timestamptz) / ($3 * 60))::int AS index, requests, errors_5xx, latency_buckets
           FROM system.request_rollups
          WHERE minute >= $1 AND minute < $2
       ), hist AS (
         SELECT index, i, sum(n)::int AS n FROM r, unnest(latency_buckets) WITH ORDINALITY AS u(n, i) GROUP BY index, i
       )
       SELECT t.index, t.requests, t.errors_5xx AS "errors5xx", (SELECT array_agg(h.n ORDER BY h.i) FROM hist h WHERE h.index = t.index) AS "latencyBuckets"
         FROM (SELECT index, sum(requests)::int AS requests, sum(errors_5xx)::int AS errors_5xx FROM r GROUP BY index) t
        ORDER BY t.index`,
      [from, to, bucketMinutes],
    );
    return res.rows.map((r) => ({
      ...r,
      latencyBuckets: r.latencyBuckets ?? [],
    }));
  }

  /** Removes samples and rollups older than `before`. */
  async deleteBefore(db: Queryable, before: Date): Promise<{ samples: number; rollups: number }> {
    const samples = await db.query(`DELETE FROM system.health_samples WHERE minute < $1`, [before]);
    const rollups = await db.query(`DELETE FROM system.request_rollups WHERE minute < $1`, [before]);
    return { samples: samples.rowCount ?? 0, rollups: rollups.rowCount ?? 0 };
  }
}
