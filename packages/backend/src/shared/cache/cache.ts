import type Redis from 'ioredis';
import { isReady } from './redis';

/** Readiness of an optional dependency: working, configured but down, or not configured. */
export type DependencyState = 'ok' | 'degraded' | 'disabled';

/**
 * Cache-aside over Redis (FMS-72). Redis is never the system of record: a
 * miss, an error or Redis being down all mean "read PostgreSQL", and the
 * request carries on. Keys are `<prefix>:cache:<module>:<entity>:<id>`
 * (CONVENTIONS.md, Redis); `key()` builds them.
 */
export interface Cache {
  key(...parts: string[]): string;
  /**
   * The cached value, or `loader()`'s, stored for `ttlSeconds`. JSON in
   * Redis: pass `revive` to restore what JSON loses (Dates).
   */
  getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>, revive?: (raw: unknown) => T): Promise<T>;
  /** Drops exact keys (after a write). */
  delete(...keys: string[]): Promise<void>;
  /** Drops every key matching a glob under the cache namespace, e.g. `fleet:vehicle:*`. Returns how many. */
  invalidate(pattern: string): Promise<number>;
  state(): DependencyState;
  /** Resolves when Redis answers (for /health/ready); rejects otherwise. */
  ping(): Promise<void>;
}

export class RedisCache implements Cache {
  constructor(
    private readonly client: Redis,
    private readonly prefix: string,
    private readonly onError: (err: unknown, op: string) => void = () => {},
  ) {}

  key(...parts: string[]): string {
    return [this.prefix, 'cache', ...parts].join(':');
  }

  async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>, revive?: (raw: unknown) => T): Promise<T> {
    if (isReady(this.client)) {
      try {
        const hit = await this.client.get(key);
        if (hit !== null) {
          const raw: unknown = JSON.parse(hit);
          return revive ? revive(raw) : (raw as T);
        }
      } catch (err) {
        this.onError(err, 'get');
        return loader();
      }
    } else {
      return loader();
    }
    const value = await loader();
    try {
      if (isReady(this.client)) await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.onError(err, 'set');
    }
    return value;
  }

  async delete(...keys: string[]): Promise<void> {
    if (keys.length === 0 || !isReady(this.client)) return;
    try {
      await this.client.unlink(...keys);
    } catch (err) {
      // Missed: the entry lives until its TTL, or until the reconnect flush.
      this.onError(err, 'delete');
    }
  }

  async invalidate(pattern: string): Promise<number> {
    if (!isReady(this.client)) return 0;
    let removed = 0;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', this.key(pattern), 'COUNT', 500);
        cursor = next;
        if (keys.length) removed += await this.client.unlink(...keys);
      } while (cursor !== '0');
    } catch (err) {
      this.onError(err, 'invalidate');
    }
    return removed;
  }

  state(): DependencyState {
    return isReady(this.client) ? 'ok' : 'degraded';
  }

  /** A connection still being set up (start-up, reconnect) gets a second to finish before Redis counts as down. */
  async ping(): Promise<void> {
    if (this.client.status === 'connecting' || this.client.status === 'connect' || this.client.status === 'reconnecting') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.client.off('ready', onReady);
          reject(new Error('redis not connected'));
        }, 1000);
        const onReady = () => {
          clearTimeout(timer);
          resolve();
        };
        this.client.once('ready', onReady);
      });
    }
    await this.client.ping();
  }
}

/** No Redis configured: every read goes to PostgreSQL. */
export class NoCache implements Cache {
  key(...parts: string[]): string {
    return ['cache', ...parts].join(':');
  }
  getOrSet<T>(_key: string, _ttl: number, loader: () => Promise<T>): Promise<T> {
    return loader();
  }
  async delete(): Promise<void> {}
  async invalidate(): Promise<number> {
    return 0;
  }
  state(): DependencyState {
    return 'disabled';
  }
  async ping(): Promise<void> {}
}
