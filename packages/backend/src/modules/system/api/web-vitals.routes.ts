import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { recordWebVital, WEB_VITAL_NAMES, WEB_VITAL_RATINGS } from '../../../shared/metrics/web-vitals-metrics';
import { authenticated } from '../../auth';

/** A route template of the web app (`/vehicles/:vehicleId`): no query string, no id, no free text. */
const page = z.string().max(80).regex(/^\/[A-Za-z0-9/:_-]*$/, 'A route template such as /vehicles/:id.');

const report = z
  .strictObject({
    name: z.enum(WEB_VITAL_NAMES),
    // Milliseconds for the times (ten minutes at most: anything longer is a stopped tab, not a measurement), a score for CLS.
    value: z.number().finite().min(0).max(600_000),
    rating: z.enum(WEB_VITAL_RATINGS),
    page: page.optional(),
  })
  .refine((r) => r.name !== 'CLS' || r.value <= 20, { message: 'A layout shift score above 20 is not a measurement.', path: ['value'] });

const body = z.strictObject({ metrics: z.array(report).min(1).max(10) });

/**
 * POST /telemetry/web-vitals (FMS-75, docs/metrics.md): the web app reports how fast pages were for a real session. Any signed-in
 * user; nothing about the user is recorded, only the metric, its rating and the page template, as Prometheus histograms.
 * 204 with no body: the browser sends it as the page closes and reads nothing back.
 */
export function webVitalsRouter(): Router {
  const router = Router();

  router.post(
    '/telemetry/web-vitals',
    authenticated(),
    asyncHandler(async (req, res) => {
      const { metrics } = parseInput(body, req.body);
      for (const metric of metrics) recordWebVital(metric);
      res.status(204).end();
    }),
  );

  return router;
}
