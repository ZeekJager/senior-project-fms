import { Router, type Request } from 'express';
import { asyncHandler } from '../../../shared/http/async-handler';
import { authorize } from '../../auth';
import type { Caller } from '../application/maintenance.service';
import type { PredictionService } from '../application/prediction.service';
import { maintenanceVehicleMissing } from '../domain/maintenance';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/**
 * Predictive maintenance reads (FMS-56): a vehicle's latest health score with the inputs behind it. The
 * score itself is on every vehicle (`health_score`); its breakdown needs prediction:read, which dispatchers
 * and drivers do not hold.
 */
export function predictionRouter(service: PredictionService): Router {
  const router = Router();

  router.get(
    '/vehicles/:vehicleId/maintenance-risk',
    authorize('prediction:read'),
    asyncHandler(async (req, res) => {
      const id = req.params.vehicleId;
      if (!UUID.test(id)) throw maintenanceVehicleMissing();
      res.json({ data: await service.risk(caller(req), id), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
