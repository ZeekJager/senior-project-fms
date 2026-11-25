import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { publicRoute } from '../../../shared/authz/route-policy';
import { AppError } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { MonitoringService } from '../application/monitoring.service';
import { RANGES, alertmanagerPayload, type Range } from '../domain/monitoring';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const metricsQuery = z.object({ range: z.enum(RANGES as unknown as [Range, ...Range[]]).default('1h') });
const windowBody = z.strictObject({
  hosts: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
});

/** A bearer token compared in constant time (hashed first, so the lengths always match). */
function bearerMatches(req: Request, expected: string | null): boolean {
  if (!expected) return false;
  const header = req.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return given.length > 0 && timingSafeEqual(a, b);
}

/**
 * Monitoring (FMS-109, FMS-163, docs/observability.md): the Resources tab's data and the capacity report (system:read),
 * maintenance windows (settings:write keeps them), and Alertmanager's webhook (public: its bearer token,
 * ALERTMANAGER_WEBHOOK_TOKEN, is the permission). Always read fresh.
 */
export function monitoringRouter(service: MonitoringService, webhookToken: string | null): Router {
  const router = Router();
  const ok = (res: Response, req: Request, data: unknown, status = 200) => res.status(status).set('Cache-Control', 'no-store').json({ data, meta: { request_id: req.correlationId } });

  router.get(
    '/system/metrics',
    authorize('system:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.metrics(parseInput(metricsQuery, req.query).range))),
  );

  router.get(
    '/system/capacity-report',
    authorize('system:read'),
    asyncHandler(async (req, res) => {
      if (req.query.format === 'pdf') {
        const pdf = await service.capacityPdf();
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="fms-capacity-${new Date().toISOString().slice(0, 10)}.pdf"`, 'Cache-Control': 'no-store' });
        res.send(pdf);
        return;
      }
      ok(res, req, await service.capacity());
    }),
  );

  router.get(
    '/system/maintenance-windows',
    authorize('system:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.windows())),
  );

  router.post(
    '/system/maintenance-windows',
    authorize('settings:write'),
    asyncHandler(async (req, res) => ok(res, req, await service.createWindow({ user: req.user!, correlationId: req.correlationId }, parseInput(windowBody, req.body ?? {})), 201)),
  );

  router.post(
    '/system/maintenance-windows/:windowId/cancel',
    authorize('settings:write'),
    asyncHandler(async (req, res) => {
      const id = req.params.windowId;
      if (!UUID.test(id)) throw new AppError(404, 'NOT_FOUND', 'Maintenance window not found.');
      ok(res, req, await service.cancelWindow({ user: req.user!, correlationId: req.correlationId }, id));
    }),
  );

  // Alertmanager (docker/observability/alertmanager.yml): POST with `Authorization: Bearer <token>`.
  router.post(
    '/system/alerts/webhook',
    publicRoute(),
    asyncHandler(async (req, res) => {
      if (!bearerMatches(req, webhookToken)) throw new AppError(401, 'AUTH_TOKEN_INVALID', 'A valid webhook token is required.');
      const result = await service.webhook(parseInput(alertmanagerPayload, req.body ?? {}), req.correlationId);
      ok(res, req, result, 202);
    }),
  );

  return router;
}
