import { LOGIN_FAILURE_WINDOW_SECONDS, LOGIN_MAX_FAILURES } from '../domain/auth-policy';

/**
 * Counts failed logins per key (account + IP). An interface so a shared
 * store (Redis, FMS-72) can replace the in-memory one once the API runs on
 * more than one instance.
 */
export interface LoginThrottle {
  /** Seconds until another attempt is allowed; 0 when allowed now. */
  retryAfter(key: string): number;
  recordFailure(key: string): void;
  reset(key: string): void;
}

const SWEEP_AT = 10_000;

/** Per-process sliding window. Counts are lost on restart. */
export class InMemoryLoginThrottle implements LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(
    private readonly maxFailures = LOGIN_MAX_FAILURES,
    windowSeconds = LOGIN_FAILURE_WINDOW_SECONDS,
    private readonly now: () => number = Date.now,
  ) {
    this.windowMs = windowSeconds * 1000;
  }

  retryAfter(key: string): number {
    const recent = this.recent(key);
    if (recent.length < this.maxFailures) return 0;
    // Allowed again once enough failures have left the window to bring the
    // count below the limit.
    const unblockAt = recent[recent.length - this.maxFailures] + this.windowMs;
    return Math.max(1, Math.ceil((unblockAt - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    if (this.failures.size >= SWEEP_AT) this.sweep();
    this.failures.set(key, [...this.recent(key), this.now()]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  /** Drops keys whose failures have all expired, so the map cannot grow without bound. */
  private sweep(): void {
    for (const key of [...this.failures.keys()]) this.recent(key);
  }
}
