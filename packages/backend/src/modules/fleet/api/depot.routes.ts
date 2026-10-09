import { Router } from 'express';
import { z } from 'zod';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery, type Page } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { DepotView } from '../infrastructure/depot.queries';

const depotListQuery = z.object(pageQuery);

export interface DepotLister {
  list(scope: Scope, page: Page): Promise<{ items: DepotView[]; total: number }>;
}

/**
 * GET /depots (api-contract §6.1): the live depots in the caller's scope, for
 * depot filters and pickers. Creating and changing depots is FMS-20.
 */
export function depotRouter(depots: DepotLister): Router {
  const router = Router();

  router.get(
    '/depots',
    authorize('depot:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(depotListQuery, req.query);
      const { items, total } = await depots.list(depotScope(req.user), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  return router;
}
