import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { publicRoute } from '../../../shared/authz/route-policy';
import { validationFailed } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { AppealService, Caller } from '../application/appeal.service';
import {
  APPEAL_KINDS,
  APPEAL_REASONS,
  APPEAL_STATUSES,
  CORRECTIONS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_COMMENT,
  MAX_EXPLANATION,
  MAX_NOTE,
  MIN_EXPLANATION,
  appealNotFound,
  attachmentNotFound,
  fileTooLarge,
  tooManyFiles,
} from '../domain/appeal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** POST /appeals: the form fields (the files are `files` parts), or the same as JSON without files. */
const submitBody = z
  .strictObject({
    kind: z.enum(APPEAL_KINDS).default('appeal'),
    target_type: z.enum(['flag', 'incident', 'score']),
    target_id: z.uuid().optional(),
    month: z.string().regex(MONTH, 'Use YYYY-MM.').optional(),
    reason: z.enum(APPEAL_REASONS),
    explanation: z.string().trim().min(MIN_EXPLANATION).max(MAX_EXPLANATION),
  })
  .superRefine((v, ctx) => {
    if (v.target_type === 'score' && !v.month) ctx.addIssue({ code: 'custom', path: ['month'], message: 'required' });
    if (v.target_type !== 'score' && !v.target_id) ctx.addIssue({ code: 'custom', path: ['target_id'], message: 'required' });
  });

const queueQuery = z.object({
  ...pageQuery,
  status: z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()))
    .pipe(z.array(z.enum(APPEAL_STATUSES)).min(1))
    .optional(),
  depot_id: z.uuid().optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const mineQuery = z.object({ ...pageQuery });
const commentBody = z.strictObject({ body: z.string().trim().min(1).max(MAX_COMMENT) });
const decisionBody = z.strictObject({
  outcome: z.enum(['approved', 'rejected']),
  note: z.string().trim().min(1).max(MAX_NOTE),
  correction: z.enum(CORRECTIONS).optional(),
  item_id: z.uuid().optional(),
});
const kpiQuery = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), depot_id: z.uuid().optional() })
  .refine((q) => new Date(q.from) < new Date(q.to), { path: ['to'], message: 'after_from' });
const contentQuery = z.object({ expires: z.string().optional(), signature: z.string().optional() });

// Up to 5 files of 5 MB, held in memory to check their first bytes, hash and store them.
const multipart = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS, fields: 10, fieldSize: 4096, parts: MAX_ATTACHMENTS + 10 },
}).array('files', MAX_ATTACHMENTS);

/** Multipart when the client sends files; a JSON body otherwise. */
const receiveFiles: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!req.is('multipart/form-data')) return next();
  multipart(req, res, (err: unknown) => {
    if (!err) return next();
    req.unpipe();
    req.resume();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(fileTooLarge());
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return next(tooManyFiles());
      return next(validationFailed([{ field: err.field ?? 'files', reason: err.code.toLowerCase() }]));
    }
    next(validationFailed([{ field: 'body', reason: 'malformed_multipart' }], 'The multipart body could not be read.'));
  });
};

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function idParam(req: Request, name: 'appealId' | 'attachmentId'): string {
  const id = req.params[name];
  if (!UUID.test(id)) throw name === 'appealId' ? appealNotFound() : attachmentNotFound();
  return id;
}

function contentDisposition(filename: string | null): string {
  if (!filename) return 'inline';
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Score appeals (FMS-159, docs/score-appeals.md). Drivers (appeal:submit) send and follow their own; reviewers
 * (appeal:review: fleet manager, depot admin, admin) claim, discuss and decide those of their depots; appeal:read (and
 * the compliance officer) reads them. Another depot's appeal, or another driver's, is 404.
 */
export function appealRouter(service: AppealService): Router {
  const router = Router();
  const ok = (res: Response, req: Request, data: unknown, status = 200) => res.status(status).json({ data, meta: { request_id: req.correlationId } });

  router.post(
    '/appeals',
    authorize('appeal:submit'),
    receiveFiles,
    asyncHandler(async (req, res) => {
      const input = parseInput(submitBody, req.body ?? {});
      const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ bytes: f.buffer, originalName: f.originalname }));
      const appeal = await service.submit(caller(req), input, files);
      res.status(201).location(`/api/v1/appeals/${appeal.id}`);
      ok(res, req, appeal, 201);
    }),
  );

  router.get(
    '/appeals/mine',
    authorize('appeal:submit'),
    asyncHandler(async (req, res) => {
      const query = parseInput(mineQuery, req.query);
      const { items, total } = await service.mine(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.get(
    '/appeals/appealable',
    authorize('appeal:submit'),
    asyncHandler(async (req, res) => ok(res, req, await service.appealable(caller(req)))),
  );

  router.get(
    '/appeals/kpis',
    authorize('appeal:read'),
    asyncHandler(async (req, res) => {
      const q = parseInput(kpiQuery, req.query);
      ok(res, req, await service.kpis(caller(req), { from: new Date(q.from), to: new Date(q.to), depot_id: q.depot_id }));
    }),
  );

  router.get(
    '/appeals',
    authorize('appeal:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(queueQuery, req.query);
      const { items, total } = await service.queue(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.get(
    '/appeals/:appealId',
    authorize('appeal:submit', 'appeal:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.get(caller(req), idParam(req, 'appealId')))),
  );

  router.post(
    '/appeals/:appealId/claim',
    authorize('appeal:review'),
    asyncHandler(async (req, res) => ok(res, req, await service.claim(caller(req), idParam(req, 'appealId')))),
  );

  router.post(
    '/appeals/:appealId/comments',
    authorize('appeal:submit', 'appeal:review'),
    asyncHandler(async (req, res) => {
      const { body } = parseInput(commentBody, req.body ?? {});
      ok(res, req, await service.comment(caller(req), idParam(req, 'appealId'), body), 201);
    }),
  );

  router.post(
    '/appeals/:appealId/decision',
    authorize('appeal:review'),
    asyncHandler(async (req, res) => ok(res, req, await service.decide(caller(req), idParam(req, 'appealId'), parseInput(decisionBody, req.body ?? {})))),
  );

  router.post(
    '/appeals/:appealId/withdraw',
    authorize('appeal:submit'),
    asyncHandler(async (req, res) => ok(res, req, await service.withdraw(caller(req), idParam(req, 'appealId')))),
  );

  router.post(
    '/appeals/:appealId/acknowledge',
    authorize('appeal:submit'),
    asyncHandler(async (req, res) => ok(res, req, await service.acknowledge(caller(req), idParam(req, 'appealId')))),
  );

  router.get(
    '/appeals/:appealId/attachments/:attachmentId/link',
    authorize('appeal:submit', 'appeal:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.attachmentLink(caller(req), idParam(req, 'appealId'), idParam(req, 'attachmentId')))),
  );

  // The signed link from .../link. Public: the signature is the permission. Served with nosniff.
  router.get(
    '/appeal-attachments/:attachmentId/content',
    publicRoute(),
    asyncHandler(async (req, res) => {
      const { expires, signature } = parseInput(contentQuery, req.query);
      const file = await service.attachmentContent(idParam(req, 'attachmentId'), expires, signature);
      res.set({
        'Content-Type': file.contentType,
        'Content-Length': String(file.sizeBytes),
        'Content-Disposition': contentDisposition(file.filename),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      file.stream.on('error', (err) => res.destroy(err));
      file.stream.pipe(res);
    }),
  );

  return router;
}
