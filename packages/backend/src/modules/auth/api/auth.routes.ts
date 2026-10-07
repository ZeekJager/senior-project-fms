import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import type { AuthService, RequestMeta } from '../application/auth.service';
import { REFRESH_COOKIE, clearSessionCookies, setSessionCookies } from './session-cookies';

const loginBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
  // The upper bound caps hashing work. No length rule beyond non-empty: a
  // short wrong password gets AUTH_INVALID_CREDENTIALS like any other.
  password: z.string().min(1).max(1024),
});

function requestMeta(req: Request): RequestMeta {
  return { correlationId: req.correlationId, ip: req.ip, userAgent: req.get('user-agent') };
}

/** POST /auth/login, /auth/refresh, /auth/logout and GET /auth/me (api-contract §5.1). */
export function authRouter(service: AuthService, authenticate: RequestHandler): Router {
  const router = Router();

  // Responses carry session cookies or the user's permissions: never cache.
  router.use('/auth', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const { email, password } = parseInput(loginBody, req.body);
      const session = await service.login(email, password, requestMeta(req));
      setSessionCookies(res, session);
      res.json({ data: await service.currentUser(session.userId), meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/auth/refresh',
    asyncHandler(async (req, res) => {
      try {
        const session = await service.refresh(req.cookies?.[REFRESH_COOKIE], requestMeta(req));
        setSessionCookies(res, session);
        res.json({ data: await service.currentUser(session.userId), meta: { request_id: req.correlationId } });
      } catch (err) {
        // A rejected refresh ends the browser's session too; a server error
        // does not, so the user can retry.
        if (err instanceof AppError && err.status < 500) clearSessionCookies(res);
        throw err;
      }
    }),
  );

  // Works with only the refresh cookie, so a user whose access token has
  // expired can still sign out.
  router.post(
    '/auth/logout',
    asyncHandler(async (req, res) => {
      await service.logout(req.cookies?.[REFRESH_COOKIE], requestMeta(req));
      clearSessionCookies(res);
      res.status(204).end();
    }),
  );

  router.get(
    '/auth/me',
    authenticate,
    asyncHandler(async (req, res) => {
      res.json({ data: await service.currentUser(req.user!.id!), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
