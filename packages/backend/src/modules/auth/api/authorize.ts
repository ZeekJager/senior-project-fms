import type { RequestHandler } from 'express';
import { AppError } from '../../../shared/errors/app-error';
import { withPolicy } from '../../../shared/authz/route-policy';
import { authenticationRequired } from '../domain/auth-errors';

const forbidden = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'You do not have permission to do this.');

/**
 * Builds `authorize` around the module's `authenticate`, so a route can never
 * check a permission without first resolving who is calling.
 *
 *     router.get('/vehicles', authorize('vehicle:read'), handler);
 *
 * Several codes mean "any one of them". Not signed in is 401 (never 403);
 * signed in without the permission is 403 FORBIDDEN_INSUFFICIENT_ROLE. The
 * check is on permission codes from the database, never on role names.
 */
export function authorizeWith(authenticate: RequestHandler) {
  return (...codes: [string, ...string[]]): RequestHandler[] => {
    const check: RequestHandler = (req, _res, next) => {
      const user = req.user;
      if (!user || user.id === null) return next(authenticationRequired());
      if (!codes.some((code) => user.permissions.includes(code))) return next(forbidden());
      next();
    };
    return [authenticate, withPolicy(check, { kind: 'permission', codes })];
  };
}

/** Any signed-in user, whatever their permissions (for example `/auth/me`). */
export function authenticatedWith(authenticate: RequestHandler) {
  return (): RequestHandler[] => [
    authenticate,
    withPolicy((_req, _res, next) => next(), { kind: 'authenticated' }),
  ];
}
