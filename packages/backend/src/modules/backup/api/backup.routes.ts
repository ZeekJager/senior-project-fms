import { Router, type Request } from 'express';
import { z } from 'zod';
import { publicRoute } from '../../../shared/authz/route-policy';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { BackupService, Caller } from '../application/backup.service';
import { backupNotFound } from '../domain/backup';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listQuery = z.object({ ...pageQuery });
const contentQuery = z.object({ user: z.string().optional(), expires: z.string().optional(), signature: z.string().optional() });

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function backupId(req: Request): string {
  const id = req.params.backupId;
  if (!UUID.test(id)) throw backupNotFound();
  return id;
}

/** Database backups (api-contract §5.3, FMS-144): admin only (backup:read, backup:write). */
export function backupRouter(service: BackupService): Router {
  const router = Router();

  router.get(
    '/system/backups',
    authorize('backup:read'),
    asyncHandler(async (req, res) => {
      const page = parseInput(listQuery, req.query);
      const { items, total } = await service.list(page.page, page.page_size);
      const overview = await service.overview();
      res.json({ data: items, meta: { ...pageMeta(page, total), ...overview, request_id: req.correlationId } });
    }),
  );

  // Back up now. 202: the dump runs in the background; the list shows it queued, running, then finished.
  router.post(
    '/system/backups',
    authorize('backup:write'),
    asyncHandler(async (req, res) => {
      const backup = await service.request(caller(req));
      res.status(202).location(`/api/v1/system/backups/${backup.id}`).json({ data: backup, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/system/backups/:backupId',
    authorize('backup:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.get(backupId(req)), meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/system/backups/:backupId/download-link',
    authorize('backup:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.link(caller(req), backupId(req)), meta: { request_id: req.correlationId } });
    }),
  );

  // The signed link's file. Public: the signature, which names the admin it was made for, is the permission.
  router.get(
    '/system/backups/:backupId/content',
    publicRoute(),
    asyncHandler(async (req, res) => {
      const file = await service.content(backupId(req), parseInput(contentQuery, req.query), req.correlationId);
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(file.sizeBytes),
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      file.stream.on('error', (err) => res.destroy(err));
      file.stream.pipe(res);
    }),
  );

  return router;
}
