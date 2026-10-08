import { Router } from 'express';
import { asyncHandler } from '../../../shared/http/async-handler';
import { authorize } from '../../auth';

export const fleetRouter = Router();

// Smoke route proving the audited mutation path end to end (FMS-03).
// Remove once the depot API (FMS-20) exists. It writes to the database, so it
// is behind the same permission as creating a depot; it was open to anyone
// until the route guard (FMS-06) flagged it.
fleetRouter.post(
  '/test-audit',
  authorize('depot:write'),
  asyncHandler(async (req, res) => {
    const inserted = await req.dbMutate('fleet.depots', 'INSERT', null, {
      name: 'Test Depot ' + Date.now(),
      location: 'Addis Ababa',
    });
    const deleted = await req.dbMutate('fleet.depots', 'DELETE', inserted.id as string);

    res.json({
      message: 'FMS-03 Audit test completed!',
      correlationId: req.correlationId,
      inserted,
      deleted,
    });
  }),
);
