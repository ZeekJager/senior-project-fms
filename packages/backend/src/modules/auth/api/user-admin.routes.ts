import { Router, type Request } from 'express';
import { publicRoute } from '../../../shared/authz/route-policy';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import type { AdminCaller, UserAdminService } from '../application/user-admin.service';
import type { UserStatus } from '../domain/auth-policy';
import { userNotFound } from '../domain/user-admin';
import { passwordSetBody, userCreateBody, userListQuery, userUpdateBody } from './user-admin.schemas';
import type { authorizeWith } from './authorize';

type Authorize = ReturnType<typeof authorizeWith>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function caller(req: Request): AdminCaller {
  return { user: req.user!, correlationId: req.correlationId, ip: req.ip };
}

/** The `{user_id}` path parameter. Anything but a UUID cannot name a user: 404. */
function userId(req: Request): string {
  const id = req.params.userId;
  if (!UUID.test(id)) throw userNotFound();
  return id;
}

/**
 * Users and roles (api-contract §5.1, FMS-78). Reads: users:read and
 * roles:read (admin, fleet_manager, compliance_officer). Writes: users:write
 * (admin). Responses that carry a one-time password link are never cached.
 */
export function userAdminRouter(service: UserAdminService, authorize: Authorize): Router {
  const router = Router();

  router.get(
    '/users',
    authorize('users:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(userListQuery, req.query);
      const { items, total } = await service.list({ ...query, status: query.status as UserStatus | undefined });
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/users',
    authorize('users:write'),
    asyncHandler(async (req, res) => {
      const { user, passwordSetup } = await service.create(caller(req), parseInput(userCreateBody, req.body));
      res
        .status(201)
        .location(`/api/v1/users/${user.id}`)
        .set('Cache-Control', 'no-store')
        .json({ data: user, meta: { password_setup: passwordSetup, request_id: req.correlationId } });
    }),
  );

  router.get(
    '/users/:userId',
    authorize('users:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.get(userId(req)), meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/users/:userId',
    authorize('users:write'),
    asyncHandler(async (req, res) => {
      const id = userId(req);
      const patch = parseInput(userUpdateBody, req.body);
      const user = await service.update(caller(req), id, { ...patch, status: patch.status as UserStatus | undefined });
      res.json({ data: user, meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/users/:userId/password-reset',
    authorize('users:write'),
    asyncHandler(async (req, res) => {
      const link = await service.issueReset(caller(req), userId(req));
      res.status(201).set('Cache-Control', 'no-store').json({ data: link, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/roles',
    authorize('roles:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.roles(), meta: { request_id: req.correlationId } });
    }),
  );

  // Public: the one-time link is the credential (256 random bits, stored as
  // a SHA-256 hash). A wrong, used or expired token gets one answer.
  router.post(
    '/auth/password',
    publicRoute(),
    asyncHandler(async (req, res) => {
      const { token, password } = parseInput(passwordSetBody, req.body);
      await service.setPassword(token, password, { correlationId: req.correlationId, ip: req.ip, userAgent: req.get('user-agent') });
      res.status(204).end();
    }),
  );

  return router;
}
