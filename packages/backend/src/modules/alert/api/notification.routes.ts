import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { InboxService } from '../application/inbox.service';
import { INBOX_STATUSES, notificationNotFound } from '../domain/notification';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One value or several, comma-separated: type=alert,alert_escalated. */
const list = z.string().transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean));

const listQuery = z.strictObject({
  ...pageQuery,
  /** all (default), unread or read. */
  status: z.enum(INBOX_STATUSES).default('all'),
  type: list.pipe(z.array(z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, 'A notification type, e.g. alert.')).min(1)).optional(),
});

/** Marking read takes no input: anything in the body is refused. */
const noBody = z.strictObject({});

function notificationId(req: Request): string {
  const id = req.params.notificationId;
  if (!UUID.test(id)) throw notificationNotFound();
  return id;
}

/**
 * The in-app inbox (api-contract §12.1, FMS-48). Every route needs notification:read, which every role holds, and
 * works on the caller's own notifications only: that is the rule, not a permission. Another user's notification
 * by id is 404, the same as a missing one. Marking read is safe to repeat.
 */
export function notificationRouter(service: InboxService): Router {
  const router = Router();

  router.get(
    '/notifications',
    authorize('notification:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total, unread } = await service.list(req.user!, query);
      res.json({ data: items, meta: { ...pageMeta(query, total), unread_count: unread, request_id: req.correlationId } });
    }),
  );

  router.post(
    '/notifications/read-all',
    authorize('notification:read'),
    asyncHandler(async (req, res) => {
      parseInput(noBody, req.body);
      const { updated } = await service.markAllRead(req.user!, req.correlationId);
      res.json({ data: { updated }, meta: { unread_count: 0, request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/notifications/:notificationId/read',
    authorize('notification:read'),
    asyncHandler(async (req, res) => {
      parseInput(noBody, req.body);
      const { notification, unread } = await service.markRead(req.user!, req.correlationId, notificationId(req));
      res.json({ data: notification, meta: { unread_count: unread, request_id: req.correlationId } });
    }),
  );

  return router;
}
