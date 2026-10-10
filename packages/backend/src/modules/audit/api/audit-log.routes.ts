import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { AuditLogService } from '../application/audit-log.service';
import { MAX_PAGE_SIZE } from '../domain/audit-log';

/** Addis Ababa is UTC+3 all year: a date filter means that local day. */
const ADDIS_OFFSET = '+03:00';

const instantOrDate = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

/** A date `to` covers that whole day: the bound is the next local midnight. */
function bound(value: string | undefined, end: boolean): string | undefined {
  if (!value || value.includes('T')) return value;
  if (!end) return `${value}T00:00:00${ADDIS_OFFSET}`;
  const next = new Date(`${value}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T00:00:00${ADDIS_OFFSET}`;
}

const listQuery = z
  .object({
    page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    cursor: z.string().min(1).max(200).optional(),
    user_id: z.uuid().optional(),
    entity_type: z
      .string()
      .regex(/^[a-z_]+\.[a-z_]+$/, 'A schema-qualified table, e.g. fleet.vehicles.')
      .optional(),
    entity_id: z.uuid().optional(),
    correlation_id: z.uuid().optional(),
    action: z.string().trim().min(1).max(100).optional(),
    result: z.enum(['success', 'denied', 'failed']).optional(),
    from: instantOrDate.optional(),
    to: instantOrDate.optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(bound(q.from, false)!) < Date.parse(bound(q.to, true)!), {
    message: '`from` must be before `to`.',
    path: ['to'],
    params: { reason: 'before_from' },
  });

/**
 * The audit trail (api-contract §5.2, FMS-28): GET /audit-logs, and /audit
 * as the legacy alias. audit:read (admin, fleet owner, compliance officer).
 * Read-only: there is no write endpoint.
 */
export function auditLogRouter(service: AuditLogService): Router {
  const router = Router();
  const handler: RequestHandler = asyncHandler(async (req, res) => {
    const q = parseInput(listQuery, req.query);
    const { items, nextCursor } = await service.list({ ...q, from: bound(q.from, false), to: bound(q.to, true) });
    res.set('Cache-Control', 'no-store').json({ data: items, meta: { page_size: q.page_size, next_cursor: nextCursor, request_id: req.correlationId } });
  });
  router.get('/audit-logs', authorize('audit:read'), handler);
  router.get('/audit', authorize('audit:read'), handler);
  return router;
}
