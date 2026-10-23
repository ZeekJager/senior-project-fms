import type Redis from 'ioredis';
import { config } from '../../config';
import { logger } from '../logging/logger';
import { NoCache, RedisCache, type Cache } from './cache';
import { createRedis } from './redis';

/**
 * The app's Redis connection and cache (FMS-72), or none when REDIS_HOST is
 * not set. After an outage every instance drops the cache namespace: writes
 * made while Redis was unreachable could not invalidate their keys.
 */
export const redis: Redis | null = config.redis
  ? createRedis(
      config.redis,
      (level, message, fields) => logger[level](fields ?? {}, message),
      // Runs on reconnect, long after this module has loaded.
      () => void cache.invalidate('*'),
    )
  : null;

export const cache: Cache = redis
  ? new RedisCache(redis, config.redis!.keyPrefix, (err, op) => logger.warn({ err, op }, 'redis cache operation failed; using PostgreSQL'))
  : new NoCache();

/**
 * Closes the connection so a script can exit: an open Redis socket keeps the
 * process alive after `pool.end()`. The server never calls it.
 */
export async function closeRedis(): Promise<void> {
  if (!redis) return;
  await redis.quit().catch(() => redis.disconnect());
}

/** `<prefix>:<namespace>:<parts>` for non-cache keys: `throttle`, `lock`, `state` (CONVENTIONS.md, Redis). */
export function redisKey(namespace: 'throttle' | 'lock' | 'state', ...parts: string[]): string {
  return [config.redis?.keyPrefix ?? 'fms', namespace, ...parts].join(':');
}

export { NoCache, RedisCache, type Cache, type DependencyState } from './cache';
export { createRedis, isReady } from './redis';
