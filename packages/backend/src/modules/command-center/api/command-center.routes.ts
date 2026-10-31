import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { OverviewService } from '../application/overview.service';

const overviewQuery = z.strictObject({ depot_id: z.uuid().optional() });

/**
 * The command center (api-contract §11.1, FMS-89). GET /command-center/overview: command:read, depot scope;
 * the drivers, trips, alerts and incidents sections each need their own read permission as well, and are null
 * without it.
 */
export function commandCenterRouter(overview: OverviewService): Router {
  const router = Router();

  router.get(
    '/command-center/overview',
    authorize('command:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(overviewQuery, req.query);
      res.json({ data: await overview.overview(req.user!, { depotId: query.depot_id }), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
