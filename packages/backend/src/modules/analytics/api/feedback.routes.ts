import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authenticated, authorize } from '../../auth';
import type { Caller } from '../application/appeal.service';
import type { FeedbackService } from '../application/feedback.service';
import {
  FEEDBACK_SUBJECTS,
  FEEDBACK_TONES,
  MAX_MESSAGE,
  MAX_REPLY,
  MAX_RETRACTION_REASON,
  MAX_TEMPLATE_TITLE,
  MIN_MESSAGE,
  feedbackNotFound,
  templateNotFound,
} from '../domain/feedback';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CATEGORY = z.string().trim().min(1).max(40);
const message = z.string().trim().min(MIN_MESSAGE).max(MAX_MESSAGE);

const giveBody = z
  .strictObject({
    subject_type: z.enum(FEEDBACK_SUBJECTS),
    trip_id: z.uuid().optional(),
    month: z.string().regex(MONTH, 'Use YYYY-MM.').optional(),
    category: CATEGORY,
    tone: z.enum(FEEDBACK_TONES),
    message,
  })
  .superRefine((v, ctx) => {
    if (v.subject_type === 'trip' && !v.trip_id) ctx.addIssue({ code: 'custom', path: ['trip_id'], message: 'required' });
    if (v.subject_type === 'month' && !v.month) ctx.addIssue({ code: 'custom', path: ['month'], message: 'required' });
    if (v.subject_type !== 'trip' && v.trip_id) ctx.addIssue({ code: 'custom', path: ['trip_id'], message: 'not_allowed' });
    if (v.subject_type !== 'month' && v.month) ctx.addIssue({ code: 'custom', path: ['month'], message: 'not_allowed' });
  });

const listQuery = z.object({ ...pageQuery, category: CATEGORY.optional(), tone: z.enum(FEEDBACK_TONES).optional() });
const mineQuery = z.object({ ...pageQuery });
const editBody = z.strictObject({ message });
const retractBody = z.strictObject({ reason: z.string().trim().min(1).max(MAX_RETRACTION_REASON) });
const replyBody = z.strictObject({ body: z.string().trim().min(1).max(MAX_REPLY) });
const templateQuery = z.object({ category: CATEGORY.optional() });
const templateBody = z.strictObject({ category: CATEGORY, title: z.string().trim().min(1).max(MAX_TEMPLATE_TITLE), body: message });
const templatePatch = templateBody.partial().refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function idParam(req: Request, name: 'feedbackId' | 'templateId' | 'driverId'): string {
  const id = req.params[name];
  if (UUID.test(id)) return id;
  if (name === 'feedbackId') throw feedbackNotFound();
  if (name === 'templateId') throw templateNotFound();
  throw new AppError(404, 'NOT_FOUND', 'Driver not found.');
}

/**
 * Admin-to-driver feedback (FMS-158, docs/driver-feedback.md). Managers (feedback:write: admin, fleet manager, depot
 * admin) give, correct and retract feedback and keep its templates; feedback:read reads a driver's. A driver of another
 * depot is 403. Drivers read their own under /driver/feedback, signed in, with no permission: anyone else's is 404.
 */
export function feedbackRouter(service: FeedbackService): Router {
  const router = Router();
  const ok = (res: Response, req: Request, data: unknown, status = 200) => res.status(status).json({ data, meta: { request_id: req.correlationId } });

  router.post(
    '/drivers/:driverId/feedback',
    authorize('feedback:write'),
    asyncHandler(async (req, res) => {
      const item = await service.give(caller(req), idParam(req, 'driverId'), parseInput(giveBody, req.body ?? {}));
      res.location(`/api/v1/feedback/${item.id}`);
      ok(res, req, item, 201);
    }),
  );

  router.get(
    '/drivers/:driverId/feedback',
    authorize('feedback:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total, counts } = await service.forDriver(caller(req), idParam(req, 'driverId'), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), counts, request_id: req.correlationId } });
    }),
  );

  // Registered before /feedback/:feedbackId, which would otherwise take "templates" as an id.
  router.get(
    '/feedback/templates',
    authorize('feedback:write'),
    asyncHandler(async (req, res) => ok(res, req, await service.templates(parseInput(templateQuery, req.query).category))),
  );

  router.post(
    '/feedback/templates',
    authorize('feedback:write'),
    asyncHandler(async (req, res) => ok(res, req, await service.createTemplate(caller(req), parseInput(templateBody, req.body ?? {})), 201)),
  );

  router.patch(
    '/feedback/templates/:templateId',
    authorize('feedback:write'),
    asyncHandler(async (req, res) => ok(res, req, await service.updateTemplate(caller(req), idParam(req, 'templateId'), parseInput(templatePatch, req.body ?? {})))),
  );

  router.delete(
    '/feedback/templates/:templateId',
    authorize('feedback:write'),
    asyncHandler(async (req, res) => {
      await service.deleteTemplate(caller(req), idParam(req, 'templateId'));
      res.status(204).end();
    }),
  );

  router.get(
    '/feedback/:feedbackId',
    authorize('feedback:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.get(caller(req), idParam(req, 'feedbackId')))),
  );

  router.patch(
    '/feedback/:feedbackId',
    authorize('feedback:write'),
    asyncHandler(async (req, res) => ok(res, req, await service.edit(caller(req), idParam(req, 'feedbackId'), parseInput(editBody, req.body ?? {}).message))),
  );

  router.post(
    '/feedback/:feedbackId/retract',
    authorize('feedback:write'),
    asyncHandler(async (req, res) => ok(res, req, await service.retract(caller(req), idParam(req, 'feedbackId'), parseInput(retractBody, req.body ?? {}).reason))),
  );

  // The driver's own. Any signed-in user: someone who is not a driver has none (404).
  router.get(
    '/driver/feedback',
    authenticated(),
    asyncHandler(async (req, res) => {
      const query = parseInput(mineQuery, req.query);
      const { items, total, unacknowledged } = await service.mine(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), unacknowledged, request_id: req.correlationId } });
    }),
  );

  router.get(
    '/driver/feedback/:feedbackId',
    authenticated(),
    asyncHandler(async (req, res) => ok(res, req, await service.mineOne(caller(req), idParam(req, 'feedbackId')))),
  );

  router.post(
    '/driver/feedback/:feedbackId/acknowledge',
    authenticated(),
    asyncHandler(async (req, res) => ok(res, req, await service.acknowledge(caller(req), idParam(req, 'feedbackId')))),
  );

  router.post(
    '/driver/feedback/:feedbackId/reply',
    authenticated(),
    asyncHandler(async (req, res) => ok(res, req, await service.reply(caller(req), idParam(req, 'feedbackId'), parseInput(replyBody, req.body ?? {}).body), 201)),
  );

  return router;
}
