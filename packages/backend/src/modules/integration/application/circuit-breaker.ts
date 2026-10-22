import CircuitBreaker from 'opossum';
import { ProviderCallError } from '../domain/adapter';
import type { CircuitState, CircuitView } from '../domain/provider';

export interface BreakerSettings {
  /** Calls (successes included) the window must hold before the breaker may open. */
  volumeThreshold: number;
  /** Opens when more than this share of the window's calls failed. */
  errorThresholdPercentage: number;
  /** How long it stays open before letting one trial call through (half-open). */
  resetTimeoutMs: number;
  /** The rolling window the counts cover. */
  windowMs: number;
}

export const DEFAULT_BREAKER: BreakerSettings = { volumeThreshold: 5, errorThresholdPercentage: 50, resetTimeoutMs: 30_000, windowMs: 60_000 };

/** Where state changes are reported (the module passes the logger). */
export interface BreakerLog {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

type Action = () => Promise<unknown>;

/**
 * One provider's circuit breaker (opossum, architecture §28.3). Closed, calls go through. Once the
 * window holds at least 5 calls and more than half failed (a timeout, a network error, a 5xx, a 408
 * or 429), it opens: 5 failures in a row always open it. Open, calls fail at once with `ProviderCallError('circuit_open')`, without reaching the provider. After
 * `resetTimeoutMs` it is half-open: the next call is a trial. Success closes it with a fresh window;
 * failure opens it again. A 4xx that is the request's fault does not count against the provider.
 *
 * Timeouts are the client's (an AbortSignal per attempt, which also cancels the request), so
 * opossum's own timer is off.
 */
export class ProviderBreaker {
  private breaker!: CircuitBreaker<[Action], unknown>;
  private openedAt: Date | null = null;
  private timeouts: number[] = [];

  constructor(
    readonly name: string,
    private readonly settings: BreakerSettings,
    private readonly log: BreakerLog,
  ) {
    this.build();
  }

  /** Runs `action` through the breaker; while open, rejects at once without running it. */
  async fire<T>(action: () => Promise<T>): Promise<T> {
    try {
      return (await this.breaker.fire(action)) as T;
    } catch (err) {
      if ((err as { code?: string }).code === 'EOPENBREAKER') {
        throw new ProviderCallError('circuit_open', `Calls to ${this.name} are paused after repeated failures.`, undefined, this.retryInMs());
      }
      if (err instanceof ProviderCallError && err.kind === 'timeout') this.timeouts.push(Date.now());
      throw err;
    }
  }

  get state(): CircuitState {
    if (this.breaker.opened) return 'open';
    if (this.breaker.halfOpen) return 'half_open';
    return 'closed';
  }

  /** Milliseconds until a trial call is let through; 0 unless open. */
  retryInMs(): number {
    if (this.state !== 'open' || !this.openedAt) return 0;
    return Math.max(0, this.openedAt.getTime() + this.settings.resetTimeoutMs - Date.now());
  }

  view(): CircuitView {
    const stats = this.breaker.stats;
    const since = Date.now() - this.settings.windowMs;
    this.timeouts = this.timeouts.filter((at) => at >= since);
    const open = this.state === 'open';
    return {
      state: this.state,
      opened_at: this.openedAt,
      retry_at: open && this.openedAt ? new Date(this.openedAt.getTime() + this.settings.resetTimeoutMs) : null,
      window: { calls: stats.fires, successes: stats.successes, failures: stats.failures, timeouts: this.timeouts.length, rejected: stats.rejects },
      latency_mean_ms: Math.round(stats.latencyMean ?? 0),
    };
  }

  /** Stops its timers (tests, shutdown, a provider whose settings changed). */
  shutdown(): void {
    this.breaker.shutdown();
  }

  private build(): void {
    const { volumeThreshold, errorThresholdPercentage, resetTimeoutMs, windowMs } = this.settings;
    this.breaker = new CircuitBreaker<[Action], unknown>((action: Action) => action(), {
      name: this.name,
      timeout: false,
      volumeThreshold,
      errorThresholdPercentage,
      resetTimeout: resetTimeoutMs,
      rollingCountTimeout: windowMs,
      rollingCountBuckets: 10,
      enableSnapshots: false,
      // True means "not the provider's fault": the call still fails, but is not counted.
      errorFilter: (err: unknown) => err instanceof ProviderCallError && !err.countsAgainstProvider,
    });
    this.breaker.on('open', () => {
      this.openedAt = new Date();
      this.log.warn({ provider: this.name, event: 'integration.circuit_opened', retry_in_ms: this.settings.resetTimeoutMs }, 'Provider circuit opened');
    });
    this.breaker.on('halfOpen', () => this.log.info({ provider: this.name, event: 'integration.circuit_half_open' }, 'Provider circuit half-open'));
    this.breaker.on('close', () => {
      this.log.info({ provider: this.name, event: 'integration.circuit_closed' }, 'Provider circuit closed');
      // opossum keeps the window's failures after closing, so one more failure would reopen it at once.
      // A recovered provider starts again from a clean window.
      this.breaker.shutdown();
      this.timeouts = [];
      this.build();
    });
  }
}
