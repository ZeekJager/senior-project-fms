import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/maintenance.service';
import type { MlModelService } from '../application/ml-model.service';
import { ML_MODEL_STATUSES } from '../domain/ml-model';

const listQuery = z.strictObject({ ...pageQuery, status: z.enum(ML_MODEL_STATUSES).optional() });

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/**
 * The model registry (FMS-127): every predictive maintenance model the system has used. Read with
 * prediction:read; only an administrator (ml-model:activate) lets a model score. Registration is the
 * scoring job's, never the API's.
 */
export function mlModelRouter(service: MlModelService): Router {
  const router = Router();

  router.get(
    '/ml-models',
    authorize('prediction:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total } = await service.list(query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.get(
    '/ml-models/:modelId',
    authorize('prediction:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.get(req.params.modelId), meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/ml-models/:modelId/activate',
    authorize('ml-model:activate'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.activate(caller(req), req.params.modelId), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
