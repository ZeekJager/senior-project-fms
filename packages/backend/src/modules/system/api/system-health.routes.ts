import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { RequestRecorder } from '../application/health-sampler';
import type { SystemHealthService } from '../application/system-health.service';
import { WINDOW_KEYS, type WindowKey } from '../domain/health';

const historyQuery = z.object({
  window: z.enum(WINDOW_KEYS as [WindowKey, ...WindowKey[]]).default('24h'),
});

/** System health (api-contract §3.8, FMS-143): admin only (system:read). Always read fresh. */
export function systemHealthRouter(service: SystemHealthService): Router {
  const router = Router();

  router.get(
    '/system/health',
    authorize('system:read'),
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        data: await service.summary(),
        meta: { request_id: req.correlationId },
      });
    }),
  );

  router.get(
    '/system/health/history',
    authorize('system:read'),
    asyncHandler(async (req, res) => {
      const { window } = parseInput(historyQuery, req.query);
      res.set('Cache-Control', 'no-store');
      res.json({
        data: await service.history(window),
        meta: { request_id: req.correlationId },
      });
    }),
  );

  return router;
}

/**
 * Counts every API request when its response is sent: its status and how long it took, nothing else.
 * Health checks are left out: a load balancer's probes would drown the traffic.
 */
export function requestRollup(recorder: RequestRecorder): RequestHandler {
  return (req, res, next) => {
    if (req.path.startsWith('/health/')) return next();
    const started = process.hrtime.bigint();
    res.once('finish', () => recorder.record(res.statusCode, Number(process.hrtime.bigint() - started) / 1e6));
    next();
  };
}
