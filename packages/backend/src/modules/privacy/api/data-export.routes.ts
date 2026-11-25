import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../../shared/errors/app-error';
import { parseInput } from '../../../shared/http/validate';
import { asyncHandler } from '../../../shared/http/async-handler';
import { authenticated, authorize } from '../../auth';
import type { DataErasureService } from '../application/data-erasure.service';
import type { DataExportService } from '../application/data-export.service';

/**
 * GET /auth/me/data-export (FMS-104, docs/driver-data-protection.md): the caller's own data as a JSON download.
 * Any signed-in user; there is no id in the path, so nobody can ask for someone else's. It holds personal data
 * and locations, so it is never cached.
 */
export function dataExportRouter(service: DataExportService, erasure: DataErasureService): Router {
  const router = Router();

  router.get(
    '/auth/me/data-export',
    authenticated(),
    asyncHandler(async (req, res) => {
      const data = await service.forUser(req.user!, req.correlationId);
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', `attachment; filename="fms-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json({ data, meta: { request_id: req.correlationId } });
    }),
  );

  // A driver's erasure (FMS-158): the personal data the modules hold for erasure, deleted for good. Admins only, with a reason.
  router.post(
    '/drivers/:driverId/data-erasure',
    authorize('privacy:erase'),
    asyncHandler(async (req, res) => {
      const id = req.params.driverId;
      if (!UUID.test(id)) throw new AppError(404, 'NOT_FOUND', 'Driver not found.');
      const { reason } = parseInput(erasureBody, req.body ?? {});
      res.json({ data: await erasure.erase(req.user!, req.correlationId, id, reason), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const erasureBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });
