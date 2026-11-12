import { Router, type Request } from 'express';
import { z } from 'zod';
import { notFound } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authenticated, authorize } from '../../auth';
import { DELAY_MARGIN_LIMITS, EXCEPTION_POLICIES } from '../../trip';
import type { Caller, RuleThresholdService, ThresholdInput } from '../application/rule-threshold.service';
import { LOCATION_THRESHOLD_LIMITS } from '../domain/location-rules';
import { THRESHOLD_LIMITS } from '../domain/telemetry-rules';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const whole = (limits: { min: number; max: number }) => z.number().int().min(limits.min).max(limits.max);

/**
 * The thresholds: a PUT replaces the row. The four of FMS-46 are required; route deviation's (FMS-90) and the trip
 * delay margins (FMS-147) are optional, and one left out keeps the row's value (or the starting one), so a client
 * from before them still works.
 */
const thresholdsBody = z
  .strictObject({
    speed_limit_kmh: whole(THRESHOLD_LIMITS.speedLimitKmh),
    speeding_pings: whole(THRESHOLD_LIMITS.speedingPings),
    clear_pings: whole(THRESHOLD_LIMITS.clearPings),
    idle_minutes: whole(THRESHOLD_LIMITS.idleMinutes),
    route_deviation_m: whole(LOCATION_THRESHOLD_LIMITS.routeDeviationM).optional(),
    route_deviation_pings: whole(LOCATION_THRESHOLD_LIMITS.routeDeviationPings).optional(),
    trip_delay_minutes: whole(DELAY_MARGIN_LIMITS.lateMinutes).optional(),
    trip_delay_urgent_minutes: whole(DELAY_MARGIN_LIMITS.urgentMinutes).optional(),
    // FMS-151: warn (the assignment goes ahead) or approve (held for a fleet manager).
    driver_attendance_exception: z.enum(EXCEPTION_POLICIES).optional(),
    trip_overrun_exception: z.enum(EXCEPTION_POLICIES).optional(),
  })
  .transform(
    (b): ThresholdInput => ({
      speedLimitKmh: b.speed_limit_kmh,
      speedingPings: b.speeding_pings,
      clearPings: b.clear_pings,
      idleMinutes: b.idle_minutes,
      routeDeviationM: b.route_deviation_m,
      routeDeviationPings: b.route_deviation_pings,
      tripDelayMinutes: b.trip_delay_minutes,
      tripDelayUrgentMinutes: b.trip_delay_urgent_minutes,
      attendanceException: b.driver_attendance_exception,
      overrunException: b.trip_overrun_exception,
    }),
  );

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function depotId(req: Request): string {
  const id = req.params.depotId;
  if (!UUID.test(id)) throw notFound('Depot not found.');
  return id;
}

/**
 * The telemetry rules' thresholds (api-contract §6.5, FMS-80, FMS-90), with the trip delay margins (FMS-147): the fleet's and each depot's that differ. Anyone
 * signed in reads them; settings:write (admin) changes them.
 */
export function ruleThresholdRouter(service: RuleThresholdService): Router {
  const router = Router();

  router.get(
    '/settings/telemetry-rules',
    authenticated(),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.list(), meta: { request_id: req.correlationId } });
    }),
  );

  router.put(
    '/settings/telemetry-rules/fleet',
    authorize('settings:write'),
    asyncHandler(async (req, res) => {
      await service.set(caller(req), null, parseInput(thresholdsBody, req.body ?? {}));
      res.json({ data: await service.list(), meta: { request_id: req.correlationId } });
    }),
  );

  router.put(
    '/settings/telemetry-rules/depots/:depotId',
    authorize('settings:write'),
    asyncHandler(async (req, res) => {
      const id = depotId(req);
      await service.set(caller(req), id, parseInput(thresholdsBody, req.body ?? {}));
      res.json({ data: await service.list(), meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/settings/telemetry-rules/depots/:depotId',
    authorize('settings:write'),
    asyncHandler(async (req, res) => {
      await service.remove(caller(req), depotId(req));
      res.status(204).end();
    }),
  );

  return router;
}
