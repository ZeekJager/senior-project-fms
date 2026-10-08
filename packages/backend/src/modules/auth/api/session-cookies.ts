import type { CookieOptions, Response } from 'express';
import type { IssuedSession } from '../application/auth.service';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from '../domain/auth-policy';

export const ACCESS_COOKIE = 'fms_access';
export const REFRESH_COOKIE = 'fms_refresh';

// HttpOnly: page scripts cannot read the tokens. SameSite=Strict: no
// cross-site request carries them, which is the CSRF defence for cookie
// auth (api-contract §21). Browsers accept Secure cookies from
// http://localhost, so development needs no exception.
const BASE: CookieOptions = { httpOnly: true, secure: true, sameSite: 'strict' };
const ACCESS: CookieOptions = { ...BASE, path: '/' };
// Sent only to the auth endpoints, never with ordinary API calls.
const REFRESH: CookieOptions = { ...BASE, path: '/api/v1/auth' };

export function setSessionCookies(res: Response, session: IssuedSession): void {
  res.cookie(ACCESS_COOKIE, session.accessToken, { ...ACCESS, maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000 });
  res.cookie(REFRESH_COOKIE, session.refreshToken, { ...REFRESH, maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000 });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, ACCESS);
  res.clearCookie(REFRESH_COOKIE, REFRESH);
}
