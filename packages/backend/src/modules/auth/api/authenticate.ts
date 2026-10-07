import type { RequestHandler } from 'express';
import { asyncHandler } from '../../../shared/http/async-handler';
import type { AuthService } from '../application/auth.service';
import { ACCESS_COOKIE } from './session-cookies';

/**
 * Requires a signed-in caller: resolves the access cookie to `req.user`
 * {id, publicId, roles, permissions, depotId}, or responds 401/403.
 */
export function authenticateWith(service: AuthService): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    req.user = await service.authenticate(req.cookies?.[ACCESS_COOKIE]);
    next();
  });
}
