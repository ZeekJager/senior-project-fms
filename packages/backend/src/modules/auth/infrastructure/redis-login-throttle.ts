import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { isReady } from '../../../shared/cache/redis';
import { retryAfterFrom, type LoginThrottle } from '../application/login-throttle';
import { LOGIN_FAILURE_WINDOW_SECONDS, LOGIN_MAX_FAILURES } from '../domain/auth-policy';

/**
 * Failed logins in Redis, shared by every API instance (FMS-72): one sorted
 * set per account and IP, scored by time, trimmed to the window and expiring
 * with it. The key is a hash: no email or IP is readable in Redis.
 */
export class RedisLoginThrottle implements LoginThrottle {
  private readonly windowMs: number;

  constructor(
    private readonly client: Redis,
    private readonly keyFor: (hashed: string) => string,
    private readonly maxFailures = LOGIN_MAX_FAILURES,
    windowSeconds = LOGIN_FAILURE_WINDOW_SECONDS,
    private readonly now: () => number = Date.now,
  ) {
    this.windowMs = windowSeconds * 1000;
  }

  available(): boolean {
    return isReady(this.client);
  }

  async retryAfter(key: string): Promise<number> {
    const k = this.key(key);
    const now = this.now();
    const [, range] = (await this.client.multi().zremrangebyscore(k, 0, now - this.windowMs).zrange(k, 0, -1, 'WITHSCORES').exec()) ?? [];
    if (range?.[0]) throw range[0];
    const flat = (range?.[1] as string[] | undefined) ?? [];
    const times = flat.filter((_, i) => i % 2 === 1).map(Number);
    return retryAfterFrom(times, this.maxFailures, this.windowMs, now);
  }

  async recordFailure(key: string): Promise<void> {
    const k = this.key(key);
    const now = this.now();
    const results = await this.client
      .multi()
      .zadd(k, now, `${now}:${randomUUID()}`)
      .zremrangebyscore(k, 0, now - this.windowMs)
      .pexpire(k, this.windowMs)
      .exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
  }

  async reset(key: string): Promise<void> {
    await this.client.del(this.key(key));
  }

  private key(raw: string): string {
    return this.keyFor(createHash('sha256').update(raw).digest('hex'));
  }
}
