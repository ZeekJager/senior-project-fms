import type { IncomingMessage } from 'node:http';
import { decodeJwt } from 'jose';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { AppError } from '../../../shared/errors/app-error';
import type { RequestUser } from '../../../types/express';
import {
  deliveriesFor,
  isStale,
  LEGACY_LOCATION_EVENT,
  roomsFor,
  roomsOf,
  SESSION_EVENTS,
  userRoom,
  type EventEnvelope,
  type ForwardLookups,
  type SocketIdentity,
} from '../domain/contract';
import { cookieValue, originAllowed, RateLimit } from '../domain/handshake';

/** A legacy location update as the contract names it (api-contract §11.2). */
export const legacyLocation = z.strictObject({
  tripId: z.uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speedKmh: z.number().min(0).max(400).nullish(),
  bearing: z.number().min(0).max(360).nullish(),
  accuracyM: z.number().min(0).max(100_000).nullish(),
});
export type LegacyLocation = z.infer<typeof legacyLocation>;

/** Where a legacy location update goes: GPS ingestion (FMS-88), which checks the trip is the sender's, as for the API. */
export type LocationIngest = (user: RequestUser, location: LegacyLocation) => Promise<void>;

export interface GatewayDeps {
  /** The caller behind an access token, as the API's `authenticate` decides it; throws a 401/403 AppError. */
  authenticate(accessToken: string | undefined): Promise<RequestUser>;
  /** The caller in public ids: depot, and driver profile for a driver. */
  identify(user: RequestUser): Promise<SocketIdentity>;
  lookups: ForwardLookups;
  accessCookie: string;
  allowedOrigins: readonly string[];
  legacyLocation: { enabled: boolean; ingest: LocationIngest | null };
  log: (level: 'debug' | 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

type Ack = (answer: { ok: true } | { ok: false; error: { code: string; message: string } }) => void;

/** Rate limit on client -> server events: 5 at once, then 1 a second; a socket that keeps exceeding it is dropped. */
const BURST = 5;
const PER_SECOND = 1;
const MAX_REFUSALS = 20;

/** A handshake refusal the client sees in `connect_error`: `message` is the code, `data` the error body. */
function refusal(code: string, message: string): Error & { data: { code: string; message: string } } {
  return Object.assign(new Error(code), { data: { code, message } });
}

/**
 * The real-time gateway (FMS-43, §20). Sockets are server -> client fan-out:
 *
 * - **Handshake.** The request's Origin is checked (originAllowed), then the
 *   access cookie, exactly as the API checks it (signature, expiry, account
 *   active, session not revoked). Anything else is refused before the socket
 *   exists. The socket closes when the access token expires; the client
 *   renews the session and reconnects, and the handshake decides again.
 * - **Rooms.** Per channel the user may read (tracking, vehicles, alerts,
 *   trips, incidents): all depots, their depot, or, for a driver, their own
 *   trips (roomsFor). A depot A dispatcher is never in a depot B room.
 * - **Delivery.** Every instance hears every domain event on Redis and sends
 *   it to its own sockets only (`io.local`), so each socket gets it once,
 *   whichever instance holds it.
 */
export class RealtimeGateway {
  private readonly now: () => number;

  constructor(
    private readonly io: Server,
    private readonly deps: GatewayDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** Whether the HTTP request that opens a socket may proceed (Socket.IO's `allowRequest`). */
  allowRequest = (req: IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void): void => {
    const origin = req.headers.origin;
    const allowed = originAllowed(origin, req.headers.host, this.deps.allowedOrigins);
    if (!allowed) this.deps.log('warn', 'socket refused: origin not allowed', { origin });
    callback(allowed ? null : 'ORIGIN_NOT_ALLOWED', allowed);
  };

  install(): void {
    this.io.use((socket, next) => {
      this.handshake(socket).then(
        () => next(),
        (err: unknown) => next(err instanceof AppError ? refusal(err.code, err.message) : refusal('AUTH_TOKEN_INVALID', 'Sign in again.')),
      );
    });
    this.io.on('connection', (socket) => this.connected(socket));
  }

  private async handshake(socket: Socket): Promise<void> {
    const token = cookieValue(socket.handshake.headers.cookie, this.deps.accessCookie);
    const user = await this.deps.authenticate(token);
    const identity = await this.deps.identify(user);
    socket.data.identity = identity;
    socket.data.user = user;
    // Verified above; only its expiry is read here.
    const exp = decodeJwt(token!).exp;
    socket.data.expiresAt = typeof exp === 'number' ? exp * 1000 : this.now();
  }

  private connected(socket: Socket): void {
    const identity = socket.data.identity as SocketIdentity;
    void socket.join(roomsFor(identity));

    // The session's access token runs out: close, so a revoked or downgraded session never outlives it.
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(0, (socket.data.expiresAt as number) - this.now()));
    socket.on('disconnect', () => clearTimeout(expiry));

    const limit = new RateLimit(BURST, PER_SECOND, this.now);
    let refusals = 0;
    socket.use((packet, next) => {
      if (limit.take()) return next();
      refusals += 1;
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function') (ack as Ack)({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many messages. Slow down.' } });
      if (refusals >= MAX_REFUSALS) {
        this.deps.log('warn', 'socket dropped: rate limit', { user_id: identity.userId });
        socket.disconnect(true);
      }
    });

    const user = socket.data.user as RequestUser;
    socket.on(LEGACY_LOCATION_EVENT, (raw: unknown, ack?: Ack) => void this.legacyLocation(identity, user, raw, typeof ack === 'function' ? ack : () => {}));
  }

  private async legacyLocation(identity: SocketIdentity, user: RequestUser, raw: unknown, ack: Ack): Promise<void> {
    const { enabled, ingest } = this.deps.legacyLocation;
    if (!enabled) return ack({ ok: false, error: { code: 'NOT_SUPPORTED', message: 'Send positions to POST /api/v1/tracking/gps-pings.' } });
    if (!identity.permissions.includes('trip:execute') && !identity.permissions.includes('tracking:ingest')) {
      return ack({ ok: false, error: { code: 'FORBIDDEN_INSUFFICIENT_ROLE', message: 'You may not send positions.' } });
    }
    const parsed = legacyLocation.safeParse(raw);
    if (!parsed.success) return ack({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'tripId, lat and lng are required; speedKmh, bearing and accuracyM are optional numbers.' } });
    if (!ingest) return ack({ ok: false, error: { code: 'NOT_AVAILABLE', message: 'Position ingestion is not running yet.' } });
    try {
      await ingest(user, parsed.data);
      ack({ ok: true });
    } catch (err) {
      ack({ ok: false, error: err instanceof AppError ? { code: err.code, message: err.message } : { code: 'INTERNAL_SERVER_ERROR', message: 'The position was not recorded.' } });
    }
  }

  /**
   * One domain event from Redis (or, without Redis, from the relay itself):
   * sent to this instance's sockets in the rooms it is for. Returns how many
   * socket events went out (for tests and logs).
   */
  async deliver(event: EventEnvelope): Promise<number> {
    if (isStale(event, this.now())) return 0;
    if (SESSION_EVENTS.includes(event.type)) {
      const userId = event.payload.user_id;
      if (typeof userId === 'string') this.io.local.in(userRoom(userId)).disconnectSockets(true);
      return 0;
    }
    const deliveries = await deliveriesFor(event, this.deps.lookups);
    for (const d of deliveries) this.io.local.to(roomsOf(d)).emit(d.event, d.payload);
    return deliveries.length;
  }
}
