import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import { FAILURE_COMPONENTS } from '../domain/failure';
import { PREDICTION_OUTCOMES } from '../domain/prediction-feedback';
import type { PredictionFeedbackService } from '../application/prediction-feedback.service';
import type { Caller } from '../application/maintenance.service';

const comment = z
  .string()
  .trim()
  .max(1000)
  .nullish()
  .transform((c) => c || null);

/** POST: the outcome; for a confirmed issue the component found and the failure record it led to. */
const createBody = z.strictObject({
  outcome: z.enum(PREDICTION_OUTCOMES),
  component: z.enum(FAILURE_COMPONENTS).nullish(),
  failure_event_id: z.uuid().nullish(),
  comment,
});

/** PATCH: the fields to change; null clears a component, a failure link or a comment. */
const patchBody = z
  .strictObject({
    outcome: z.enum(PREDICTION_OUTCOMES),
    component: z.enum(FAILURE_COMPONENTS).nullable(),
    failure_event_id: z.uuid().nullable(),
    comment,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/**
 * Feedback on a prediction (FMS-128): what a technician found when they inspected a vehicle the model
 * flagged. Needs prediction:read (to see the prediction) and maintenance:write (to record what was found):
 * technicians, depot admins, fleet managers, admins. A prediction on a vehicle outside the caller's depots is
 * 404. One feedback per prediction; its author can change it for 7 days.
 */
export function predictionFeedbackRouter(service: PredictionFeedbackService): Router {
  const router = Router();

  router.post(
    '/maintenance-predictions/:predictionId/feedback',
    authorize('prediction:read'),
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const feedback = await service.record(caller(req), req.params.predictionId, parseInput(createBody, req.body));
      res
        .status(201)
        .location(`/api/v1/maintenance-predictions/${feedback.prediction_id}/feedback`)
        .json({ data: feedback, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/maintenance-predictions/:predictionId/feedback',
    authorize('prediction:read'),
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const feedback = await service.edit(caller(req), req.params.predictionId, parseInput(patchBody, req.body));
      res.json({ data: feedback, meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
