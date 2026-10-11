import Redis from 'ioredis';
import type { RedisConfig } from '../../config/schema';

export type RedisLog = (level: 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void;

/**
 * The shared Redis connection (FMS-72). Fails fast instead of waiting: no
 * offline queue, one retry, 250 ms per command. Callers treat any error as
 * "Redis unavailable" and fall back (direct PostgreSQL reads, the in-memory
 * throttle, the PostgreSQL job lock). It reconnects on its own with backoff
 * up to 5 s; `onReconnect` runs each time it comes back after an outage.
 */
export function createRedis(config: RedisConfig, log: RedisLog = () => {}, onReconnect?: () => void): Redis {
  const client = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 250,
    connectTimeout: 2000,
    retryStrategy: (attempt) => Math.min(attempt * 250, 5000),
  });
  let wasReady = false;
  let down = false;
  client.on('ready', () => {
    if (down) {
      log('info', 'redis reconnected');
      onReconnect?.();
    }
    wasReady = true;
    down = false;
  });
  client.on('error', (err: Error) => {
    // One line per outage, not one per reconnect attempt.
    if (!down) log('warn', wasReady ? 'redis connection lost; reading PostgreSQL directly' : 'redis unavailable; reading PostgreSQL directly', { err: err.message });
    down = true;
  });
  client.on('end', () => {
    down = true;
  });
  return client;
}

/** Whether commands can be sent now. Anything else: skip Redis. */
export function isReady(client: Redis | null): client is Redis {
  return client?.status === 'ready';
}
