import { Router } from 'express';
import { asyncHandler } from '../../../shared/http/async-handler';
import { authenticated } from '../../auth';
import type { DataExportService } from '../application/data-export.service';

/**
 * GET /auth/me/data-export (FMS-104, docs/driver-data-protection.md): the caller's own data as a JSON download.
 * Any signed-in user; there is no id in the path, so nobody can ask for someone else's. It holds personal data
 * and locations, so it is never cached.
 */
export function dataExportRouter(service: DataExportService): Router {
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

  return router;
}
