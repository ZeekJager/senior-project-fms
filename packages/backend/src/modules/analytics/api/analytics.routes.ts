import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { AnalyticsService, Report } from '../application/analytics.service';

/** Addis Ababa days, both included; a depot by public id. */
const analyticsQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  depot_id: z.uuid().optional(),
});

const REPORTS: readonly Report[] = ['fleet-summary', 'utilisation', 'fuel-efficiency', 'maintenance-risk', 'trips', 'alerts'];

/**
 * The analytics API (api-contract §14, FMS-50), `analytics:read`, in the caller's depot scope. Every answer is from
 * analytics_cache and the analytics views on the read replica, and says in `meta` how old the cache is (`computed_at`,
 * `stale` after 25 hours) and which database answered (`data_freshness`).
 */
export function analyticsRouter(service: AnalyticsService): Router {
  const router = Router();
  for (const report of REPORTS) {
    router.get(
      `/analytics/${report}`,
      authorize('analytics:read'),
      asyncHandler(async (req, res) => {
        const { data, meta } = await service.report(report, req.user, parseInput(analyticsQuery, req.query));
        res.json({ data, meta: { ...meta, request_id: req.correlationId } });
      }),
    );
  }
  return router;
}
