import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { AlertService } from '../application/alert.service';
import { alertNotFound, SEVERITIES, STATUSES } from '../domain/alert';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One value or several, comma-separated: status=open,acknowledged. */
const list = z.string().transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean));

const listQuery = z.strictObject({
  ...pageQuery,
  status: list.pipe(z.array(z.enum(STATUSES)).min(1)).optional(),
  severity: list.pipe(z.array(z.enum(SEVERITIES)).min(1)).optional(),
  type: list.pipe(z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/, 'An alert type, e.g. vehicle_fault.')).min(1)).optional(),
  vehicle_id: z.uuid().optional(),
  depot_id: z.uuid().optional(),
  /** newest (default), or priority: critical first, then newest. */
  sort: z.enum(['newest', 'priority']).default('newest'),
});

/** An optional note on the alert's history: what was done, by whom. */
const actionBody = z.strictObject({ comment: z.string().trim().max(1000).optional() });

function alertId(req: Request): string {
  const id = req.params.alertId;
  if (!UUID.test(id)) throw alertNotFound();
  return id;
}

/**
 * Alerts (api-contract §12.1, FMS-92). Reads: alert:read, depot scope (a depot's staff see their depot's
 * alerts; an alert no depot owns is seen by those who see every depot). Acknowledge: alert:ack.
 * Resolve: alert:resolve.
 */
export function alertRouter(service: AlertService): Router {
  const router = Router();

  router.get(
    '/alerts',
    authorize('alert:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, meta } = await service.list(req.user!, query);
      res.json({ data: items, meta: { ...meta, request_id: req.correlationId } });
    }),
  );

  router.get(
    '/alerts/:alertId',
    authorize('alert:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.get(req.user!, alertId(req)), meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/alerts/:alertId/acknowledge',
    authorize('alert:ack'),
    asyncHandler(async (req, res) => {
      const id = alertId(req);
      const { comment } = parseInput(actionBody, req.body ?? {});
      res.json({ data: await service.acknowledge(req.user!, id, comment ?? null, req.correlationId), meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/alerts/:alertId/resolve',
    authorize('alert:resolve'),
    asyncHandler(async (req, res) => {
      const id = alertId(req);
      const { comment } = parseInput(actionBody, req.body ?? {});
      res.json({ data: await service.resolve(req.user!, id, comment ?? null, req.correlationId), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
