import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/fuel-log.service';
import type { ReconciliationService } from '../application/reconciliation.service';
import { RECONCILIATION_STATUSES, vehicleNotFound } from '../domain/reconciliation';
import { bound, instantOrDate } from './dates';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const period = {
  from: instantOrDate.optional(),
  to: instantOrDate.optional(),
};
const toDates = <T extends { from?: string; to?: string }>({ from, to, ...rest }: T) => ({
  ...rest,
  from: from ? bound(from, false) : undefined,
  to: to ? bound(to, true) : undefined,
});

const reconciliationQuery = z
  .object({
    ...pageQuery,
    ...period,
    vehicle_id: z.uuid().optional(),
    depot_id: z.uuid().optional(),
    status: z.enum(RECONCILIATION_STATUSES).optional(),
  })
  .transform(toDates);

const summaryQuery = z.object(period).transform(toDates);

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/**
 * Fuel reconciliation (api-contract §9.2, FMS-41) and a vehicle's fuel summary (§9.1). Both only read.
 *
 * GET /fuel-reconciliation needs `analytics:read` and `fuel:read`, both: it is fuel analytics, so a driver (fuel:read
 * only) and a dispatcher (analytics:read only) are refused. GET /vehicles/{id}/fuel-summary needs `fuel:read`, in the
 * depot scope; a driver gets 404, as a vehicle's totals include other drivers' fill-ups.
 */
export function reconciliationRouter(service: ReconciliationService): Router {
  const router = Router();

  router.get(
    '/fuel-reconciliation',
    authorize('analytics:read'),
    authorize('fuel:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(reconciliationQuery, req.query);
      const { items, total, summary, from, to, thresholdPct } = await service.reconcile(caller(req), query);
      res.json({
        data: items,
        meta: { ...pageMeta(query, total), from, to, threshold_pct: thresholdPct, summary, request_id: req.correlationId },
      });
    }),
  );

  router.get(
    '/vehicles/:vehicleId/fuel-summary',
    authorize('fuel:read'),
    asyncHandler(async (req, res) => {
      if (!UUID.test(req.params.vehicleId)) throw vehicleNotFound();
      const summary = await service.summary(caller(req), req.params.vehicleId, parseInput(summaryQuery, req.query));
      res.json({ data: summary, meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
