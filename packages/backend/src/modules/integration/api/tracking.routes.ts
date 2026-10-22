import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { webhookChannel } from '../../../middleware/requestSource';
import { withPolicy } from '../../../shared/authz/route-policy';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { IngestionService, Reporter } from '../application/ingestion.service';
import type { LiveMapService } from '../application/live-map.service';
import { deviceTokenInvalid } from '../domain/gps';
import { apiPingBatch } from '../domain/ping-schema';
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

/**
 * POST /tracking/gps-pings (api-contract §11.1, FMS-88): a batch of positions, answered with what was stored.
 * GET /tracking/vehicles/current (FMS-45): the live map's snapshot.
 */
export function trackingRouter(service: IngestionService, liveMap: LiveMapService): Router {
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
  return router;
}
