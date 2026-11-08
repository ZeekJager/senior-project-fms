import type { CookieOptions, Response } from 'express';
import { config } from '../../../config';
import { CSRF_COOKIE, CsrfTokens } from '../../../shared/http/csrf';
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

// The CSRF token (FMS-103, shared/http/csrf.ts): readable by the page, which echoes it in X-CSRF-Token, so not HttpOnly. It is signed for this
// session's access token and replaced with it at every sign-in and refresh. SameSite=Strict and Secure like the session itself.
const CSRF: CookieOptions = { httpOnly: false, secure: true, sameSite: 'strict', path: '/' };
const csrfTokens = new CsrfTokens(config.jwtSecret);

export function setSessionCookies(res: Response, session: IssuedSession): void {
  res.cookie(ACCESS_COOKIE, session.accessToken, { ...ACCESS, maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000 });
  res.cookie(REFRESH_COOKIE, session.refreshToken, { ...REFRESH, maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000 });
  res.cookie(CSRF_COOKIE, csrfTokens.issue(session.accessToken), { ...CSRF, maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000 });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, ACCESS);
  res.clearCookie(REFRESH_COOKIE, REFRESH);
  res.clearCookie(CSRF_COOKIE, CSRF);
}
