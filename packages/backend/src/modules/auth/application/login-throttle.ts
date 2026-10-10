import { LOGIN_FAILURE_WINDOW_SECONDS, LOGIN_MAX_FAILURES } from '../domain/auth-policy';

/**
 * Counts failed logins per key (account + IP). Redis holds the count when it
 * is up (shared by every API instance, FMS-72); the in-memory one stands in
 * while it is not (ResilientLoginThrottle).
 */
export interface LoginThrottle {
  /** Seconds until another attempt is allowed; 0 when allowed now. */
  retryAfter(key: string): Promise<number>;
  recordFailure(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

/** When to block: from the failures' timestamps (ms, oldest first) inside the window. */
export function retryAfterFrom(failures: readonly number[], maxFailures: number, windowMs: number, now: number): number {
  if (failures.length < maxFailures) return 0;
  // Allowed again once enough failures have left the window to bring the
  // count below the limit.
  const unblockAt = failures[failures.length - maxFailures] + windowMs;
  return Math.max(1, Math.ceil((unblockAt - now) / 1000));
}

/**
 * Redis first, the in-memory throttle when Redis is unavailable or fails:
 * a login is never refused or let through because the cache is down. Counts
 * made in memory during an outage stay in that process.
 */
export class ResilientLoginThrottle implements LoginThrottle {
  constructor(
    private readonly shared: (LoginThrottle & { available(): boolean }) | null,
    private readonly local: LoginThrottle,
  ) {}

  retryAfter(key: string): Promise<number> {
    return this.use((t) => t.retryAfter(key));
  }
  recordFailure(key: string): Promise<void> {
    return this.use((t) => t.recordFailure(key));
  }
  reset(key: string): Promise<void> {
    return this.use((t) => t.reset(key));
  }

  private async use<T>(fn: (throttle: LoginThrottle) => Promise<T>): Promise<T> {
    if (this.shared?.available()) {
      try {
        return await fn(this.shared);
      } catch {
        // Fall through to the local count.
      }
    }
    return fn(this.local);
  }
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

  async retryAfter(key: string): Promise<number> {
    return retryAfterFrom(this.recent(key), this.maxFailures, this.windowMs, this.now());
  }

  async recordFailure(key: string): Promise<void> {
    if (this.failures.size >= SWEEP_AT) this.sweep();
    this.failures.set(key, [...this.recent(key), this.now()]);
  }

  async reset(key: string): Promise<void> {
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
