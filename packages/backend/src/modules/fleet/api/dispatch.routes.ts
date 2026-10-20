import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/caller';
import type { DispatchService } from '../application/dispatch.service';
import { vehicleStatusQuery } from './vehicle.schemas';

/** Which depot, and the trip being staffed (its own assignment is not a conflict). The window is `from`/`to`, as for vehicle status. */
const boardQuery = z.object({ depot_id: z.uuid().optional(), exclude_trip_id: z.uuid().optional() });

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/**
 * The dispatcher's board (FMS-33, S-07): GET /dispatch/availability needs
 * trip:assign (admin, fleet manager, dispatcher), the people who staff trips.
 */
export function dispatchRouter(service: DispatchService): Router {
  const router = Router();

  router.get(
    '/dispatch/availability',
    authorize('trip:assign'),
    asyncHandler(async (req, res) => {
      const { depot_id, exclude_trip_id } = parseInput(boardQuery, req.query);
      const window = parseInput(vehicleStatusQuery, req.query);
      const board = await service.board(caller(req), { depotId: depot_id, excludeTripId: exclude_trip_id, window });
      res.json({ data: board, meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
