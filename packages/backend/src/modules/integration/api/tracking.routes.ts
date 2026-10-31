import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { webhookChannel } from '../../../middleware/requestSource';
import { withPolicy } from '../../../shared/authz/route-policy';
import { notFound } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { IngestionService, Reporter } from '../application/ingestion.service';
import type { LiveMapService } from '../application/live-map.service';
import type { TelemetryRulesService } from '../application/telemetry-rules.service';
import type { TrackHistoryService } from '../application/track-history.service';
import { deviceTokenInvalid } from '../domain/gps';
import { apiPingBatch } from '../domain/ping-schema';
import { decodeTrackCursor, TRACK_PAGE_DEFAULT, TRACK_PAGE_MAX } from '../domain/track-history';
import type { DeviceRow } from '../infrastructure/device.repository';

/** Runs an `authorize(...)` chain (sign in, then the permission check) as one middleware. */
function chain(handlers: RequestHandler[]): RequestHandler {
  return (req, res, next) => {
    const step = (i: number) => (err?: unknown) => {
      if (err || i === handlers.length) return next(err);
      handlers[i](req, res, step(i + 1));
    };
    step(0)();
  };
}

/**
 * Who may post pings: a device with its token (`Authorization: Bearer fmsd_...`), whose requests are
 * recorded as machine traffic (channel webhook), or a signed-in user with `tracking:ingest` or, for a
 * driver's phone, `trip:execute`. Which vehicles each may report for is the service's rule.
 */
function ingestCaller(service: IngestionService): RequestHandler {
  const user = chain(authorize('tracking:ingest', 'trip:execute'));
  const handler = (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization');
    if (!header) return user(req, res, next);
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    (token ? service.authenticateDevice(token) : Promise.resolve(null)).then((device) => {
      if (!device) return next(deviceTokenInvalid());
      res.locals.device = device;
      webhookChannel(req, res, next);
    }, next);
  };
  return withPolicy(handler, { kind: 'permission', codes: ['tracking:ingest', 'trip:execute'] });
}

/** GET /tracking/vehicles/current: optionally one depot (public id) of the caller's scope. */
const currentQuery = z.strictObject({ depot_id: z.uuid().optional() });

/** The flag types of tracking.telemetry_flag_type (migration 007). */
const FLAG_TYPE_VALUES = ['speeding', 'idling', 'fuel_variance', 'route_deviation', 'geofence_violation', 'harsh_braking', 'other'] as const;

/** GET /vehicles/{vehicle_id}/telemetry-flags: types (comma-separated), a period of observed_at, ongoing or ended, how many. */
const flagsQuery = z
  .strictObject({
    flag_type: z
      .string()
      .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
      .pipe(z.array(z.enum(FLAG_TYPE_VALUES)).min(1))
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    ongoing: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .transform((q) => ({
    types: q.flag_type ?? null,
    from: q.from ? new Date(q.from) : null,
    to: q.to ? new Date(q.to) : null,
    ongoing: q.ongoing === undefined ? null : q.ongoing === 'true',
    limit: q.limit,
  }));

/** GET /vehicles/{vehicle_id}/tracking: a period of recorded_at (both ends included), a page size, the next page's cursor. */
const trackQuery = z
  .strictObject({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(TRACK_PAGE_MAX).default(TRACK_PAGE_DEFAULT),
    cursor: z.string().max(200).optional(),
  })
  .transform((q) => ({
    from: q.from ? new Date(q.from) : null,
    to: q.to ? new Date(q.to) : null,
    limit: q.limit,
    cursor: q.cursor ? decodeTrackCursor(q.cursor) : null,
  }));

/**
 * POST /tracking/gps-pings (api-contract §11.1, FMS-88): a batch of positions, answered with what was stored.
 * GET /tracking/vehicles/current (FMS-45): the live map's snapshot.
 * GET /vehicles/{vehicle_id}/telemetry-flags (FMS-46): the vehicle's speeding and idling flags.
 * GET /vehicles/{vehicle_id}/tracking (FMS-136): the vehicle's GPS history, oldest first, a page at a time.
 * Behavioural data (§24.3): tracking:read only, never drivers, in the caller's depot scope.
 */
export function trackingRouter(service: IngestionService, liveMap: LiveMapService, rules: TelemetryRulesService, history: TrackHistoryService): Router {
  const router = Router();
  router.get(
    '/tracking/vehicles/current',
    authorize('tracking:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(currentQuery, req.query);
      const data = await liveMap.current(req.user!, { depotId: query.depot_id });
      res.json({ data, meta: { request_id: req.correlationId } });
    }),
  );
  router.post(
    '/tracking/gps-pings',
    ingestCaller(service),
    asyncHandler(async (req, res) => {
      const { pings } = parseInput(apiPingBatch, req.body);
      const device = res.locals.device as DeviceRow | undefined;
      const reporter: Reporter = device ? { kind: 'device', device } : { kind: 'user', user: req.user! };
      const result = await service.ingest(reporter, pings, req.correlationId);
      res.status(202).json({ data: result, meta: { request_id: req.correlationId } });
    }),
  );
  router.get(
    '/vehicles/:vehicleId/telemetry-flags',
    authorize('tracking:read'),
    asyncHandler(async (req, res) => {
      const vehicleId = z.uuid().safeParse(req.params.vehicleId);
      if (!vehicleId.success) throw notFound('Vehicle not found.');
      const query = parseInput(flagsQuery, req.query);
      const data = await rules.listForVehicle(req.user!, vehicleId.data, query);
      res.json({ data, meta: { request_id: req.correlationId } });
    }),
  );
  router.get(
    '/vehicles/:vehicleId/tracking',
    authorize('tracking:read'),
    asyncHandler(async (req, res) => {
      const vehicleId = z.uuid().safeParse(req.params.vehicleId);
      if (!vehicleId.success) throw notFound('Vehicle not found.');
      const query = parseInput(trackQuery, req.query);
      const { points, nextCursor } = await history.forVehicle(req.user!, vehicleId.data, query);
      res.json({ data: points, meta: { page_size: query.limit, next_cursor: nextCursor, request_id: req.correlationId } });
    }),
  );
  return router;
}
