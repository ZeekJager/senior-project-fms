import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { Server } from 'socket.io';
import { config } from '../../config';
import { pool } from '../../db';
import { redis as sharedRedis } from '../../shared/cache';
import type { EventBroadcaster } from '../../shared/events/broadcaster';
import { envelopeOf } from '../../shared/events/domain-event';
import { eventChannel } from '../../shared/events/event-bus';
import { logger } from '../../shared/logging/logger';
import type { RequestUser } from '../../types/express';
import { ACCESS_COOKIE, authenticateAccessToken, depotScope, ownDriverScope } from '../auth';
import { depotDirectory, tripRefs } from '../fleet';
import { tripLookups } from '../trip';
import { RealtimeGateway, type LocationIngest } from './application/gateway';
import { SOCKET_PATH, type EventEnvelope, type SocketIdentity } from './domain/contract';

export interface RealtimeOptions {
  /** The Redis connection to base the adapter and the event subscription on; null for one instance with no Redis. Defaults to the app's. */
  redis?: Redis | null;
  allowedOrigins?: readonly string[];
  legacyLocation?: { enabled: boolean; ingest: LocationIngest | null };
  now?: () => number;
}

export interface Realtime {
  io: Server;
  gateway: RealtimeGateway;
  /**
   * For the outbox relay when there is no Redis (one instance): hands each
   * committed event straight to this instance's sockets.
   */
  localBroadcaster: EventBroadcaster;
  /** Resolves once the event subscription is listening (immediately without Redis). */
  ready: Promise<void>;
  close(): Promise<void>;
}

/** The caller in public ids, for rooms: depot scope, and the driver profile of a driver. */
async function identify(user: RequestUser): Promise<SocketIdentity> {
  const scope = depotScope(user);
  let depots: SocketIdentity['depots'] = { kind: 'none' };
  if (scope.kind === 'all') depots = { kind: 'all' };
  else if (scope.kind === 'depot') {
    const depotId = await depotDirectory.publicIdOf(scope.depotId);
    if (depotId) depots = { kind: 'depot', depotId };
  }
  let driver: SocketIdentity['driver'] = null;
  const own = ownDriverScope(user);
  if (own.kind === 'own') {
    const id = await tripRefs.drivers.idOfUser(pool, own.userId);
    driver = { driverId: id ? ((await tripRefs.drivers.publicIds(pool, [id])).get(id) ?? null) : null };
  }
  return { userId: user.publicId!, permissions: user.permissions, depots, driver };
}

/**
 * Real-time fan-out (FMS-43): a Socket.IO server on the API's HTTP server, at
 * SOCKET_PATH. With Redis, the Redis adapter joins the instances (one
 * user's sockets can be closed from any of them), and each instance
 * subscribes to every domain event (`<prefix>:events:*`) and sends it to its
 * own sockets. See docs/realtime.md.
 */
export function attachRealtime(httpServer: HttpServer, options: RealtimeOptions = {}): Realtime {
  const redis = options.redis === undefined ? sharedRedis : options.redis;
  const log = (level: 'debug' | 'info' | 'warn', message: string, fields: Record<string, unknown> = {}) => logger[level](fields, message);

  const io = new Server(httpServer, {
    path: SOCKET_PATH,
    serveClient: false,
    // Origins are checked in allowRequest; no CORS headers for anyone else.
    cors: { origin: [...(options.allowedOrigins ?? config.realtime.allowedOrigins)], credentials: true },
  });
  const gateway = new RealtimeGateway(io, {
    authenticate: authenticateAccessToken,
    identify,
    lookups: { tripSummary: (tripId) => tripLookups.summary(pool, tripId) },
    accessCookie: ACCESS_COOKIE,
    allowedOrigins: options.allowedOrigins ?? config.realtime.allowedOrigins,
    legacyLocation: options.legacyLocation ?? { enabled: config.realtime.legacyLocation, ingest: null },
    log,
    now: options.now,
  });
  io.engine.opts.allowRequest = gateway.allowRequest;
  gateway.install();

  const deliver = (envelope: EventEnvelope) =>
    gateway.deliver(envelope).catch((err: unknown) => log('warn', 'realtime delivery failed', { event_type: envelope.type, err: (err as Error).message }));

  const connections: Redis[] = [];
  let ready = Promise.resolve();
  if (redis) {
    // Subscriber connections queue their (re)subscriptions until connected, unlike the shared fail-fast client.
    const connect = () => {
      const c = redis.duplicate({ enableOfflineQueue: true, commandTimeout: undefined });
      connections.push(c);
      return c;
    };
    const pub = connect();
    const sub = connect();
    io.adapter(createAdapter(pub, sub, { key: `${config.redis?.keyPrefix ?? 'fms'}:socket.io` }));
    const events = connect();
    events.on('pmessage', (_pattern: string, _channel: string, message: string) => {
      try {
        void deliver(JSON.parse(message) as EventEnvelope);
      } catch {
        log('warn', 'realtime: unreadable event on redis');
      }
    });
    ready = events.psubscribe(eventChannel('*')).then(() => undefined);
  }

  return {
    io,
    gateway,
    localBroadcaster: {
      publish: async (event) => void (await deliver(JSON.parse(JSON.stringify(envelopeOf(event))) as EventEnvelope)),
    },
    ready,
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.all(connections.map((c) => c.quit().catch(() => undefined)));
    },
  };
}

export { SOCKET_EVENTS, SOCKET_PATH } from './domain/contract';
export type { LegacyLocation, LocationIngest } from './application/gateway';
