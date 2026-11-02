import { Router, type Request } from 'express';
import { z } from 'zod';
import { notFound } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authenticated, authorize } from '../../auth';
import type { Caller, RuleThresholdService } from '../application/rule-threshold.service';
import { THRESHOLD_LIMITS, type RuleThresholds } from '../domain/telemetry-rules';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const whole = (limits: { min: number; max: number }) => z.number().int().min(limits.min).max(limits.max);

/** The four thresholds, all of them: a PUT replaces the row. */
const thresholdsBody = z
  .strictObject({
    speed_limit_kmh: whole(THRESHOLD_LIMITS.speedLimitKmh),
    speeding_pings: whole(THRESHOLD_LIMITS.speedingPings),
    clear_pings: whole(THRESHOLD_LIMITS.clearPings),
    idle_minutes: whole(THRESHOLD_LIMITS.idleMinutes),
  })
  .transform(
    (b): RuleThresholds => ({ speedLimitKmh: b.speed_limit_kmh, speedingPings: b.speeding_pings, clearPings: b.clear_pings, idleMinutes: b.idle_minutes }),
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
 * The telemetry rules' thresholds (api-contract §6.5, FMS-80): the fleet's and each depot's that differ. Anyone
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
