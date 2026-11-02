import { Router, type Request } from 'express';
import { asyncHandler } from '../../../shared/http/async-handler';
import { receivePhoto, sendPhoto, uploadedPhoto } from '../../../shared/storage/photo';
import type { PhotoActor, UserPhotoService } from '../application/user-photo.service';
import { userNotFound } from '../domain/user-admin';
import type { authenticatedWith, authorizeWith } from './authorize';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actor(req: Request): PhotoActor {
  return { userId: req.user!.id, correlationId: req.correlationId };
}

function userId(req: Request): string {
  const id = req.params.userId;
  if (!UUID.test(id)) throw userNotFound();
  return id;
}

/**
 * Users' photos (docs/photos.md): everyone sets and removes their own; an admin (users:write) anyone's. Reading
 * one is the user's own, or anyone's for those who see people lists (users:read, driver:read).
 */
export function userPhotoRouter(
  service: UserPhotoService,
  authorize: ReturnType<typeof authorizeWith>,
  authenticated: ReturnType<typeof authenticatedWith>,
): Router {
  const router = Router();

  router.put(
    '/auth/me/photo',
    authenticated(),
    receivePhoto,
    asyncHandler(async (req, res) => {
      res.json({ data: await service.set(actor(req), { id: req.user!.id! }, uploadedPhoto(res)), meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/auth/me/photo',
    authenticated(),
    asyncHandler(async (req, res) => {
      await service.remove(actor(req), { id: req.user!.id! });
      res.status(204).end();
    }),
  );

  router.put(
    '/users/:userId/photo',
    authorize('users:write'),
    receivePhoto,
    asyncHandler(async (req, res) => {
      res.json({ data: await service.set(actor(req), { publicId: userId(req) }, uploadedPhoto(res)), meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/users/:userId/photo',
    authorize('users:write'),
    asyncHandler(async (req, res) => {
      await service.remove(actor(req), { publicId: userId(req) });
      res.status(204).end();
    }),
  );

  router.get(
    '/users/:userId/photo',
    authenticated(),
    asyncHandler(async (req, res) => {
      sendPhoto(res, await service.read(req.user!, userId(req)));
    }),
  );

  return router;
}
