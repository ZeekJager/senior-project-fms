import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors/app-error';

/**
 * CSRF defence for cookie-authenticated requests (FMS-103, api-contract §21, docs/security.md). The session cookies are SameSite=Strict,
 * which already keeps them off cross-site requests; this is the second and third layer:
 *
 * 1. **Origin.** A state-changing request (POST, PUT, PATCH, DELETE) that carries the session cookies must come from this site: its
 *    `Origin` has to be this host, or one of the allowed origins; with no `Origin`, `Sec-Fetch-Site` must not say cross-site.
 * 2. **Token.** It must also send `X-CSRF-Token`, equal to the `fms_csrf` cookie the server set at sign-in (double submit), and the
 *    token must be one this server signed *for this session's access token*. A cookie planted from a sibling subdomain, or one taken from
 *    the attacker's own session, fails the signature.
 *
 * Requests with no session cookie (devices, webhooks, sign-in) are not cookie-authenticated and are not CSRF targets.
 */
export const CSRF_COOKIE = 'fms_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Makes and checks tokens: a random value and its HMAC with the session's access token, under a key derived from the app's secret. */
export class CsrfTokens {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHmac('sha256', secret).update('fms-csrf-v1').digest();
  }

  private sign(random: string, accessToken: string): string {
    return createHmac('sha256', this.key).update(`${random}.${accessToken}`).digest('base64url');
  }

  /** A token for the session that this access token starts. */
  issue(accessToken: string): string {
    const random = randomBytes(24).toString('base64url');
    return `${random}.${this.sign(random, accessToken)}`;
  }

  /** Whether the token was issued by this server for this access token. */
  valid(token: string, accessToken: string): boolean {
    const [random, signature, extra] = token.split('.');
    if (!random || !signature || extra !== undefined) return false;
    const expected = Buffer.from(this.sign(random, accessToken));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface CsrfOptions {
  tokens: CsrfTokens;
  /** Origins other than this host that may make cookie-authenticated requests (CORS_ALLOWED_ORIGINS). */
  allowedOrigins: readonly string[];
  accessCookie: string;
  refreshCookie: string;
  /** Whether the token is checked as well as the origin. Always true in a deployment (app.ts). */
  requireToken: boolean;
  /**
   * Routes whose callers cannot send the header: sign-in, the silent refresh and sign-out (the token does not exist yet, or may be
   * stale), and the web vitals beacon (sendBeacon sets no headers). They still pass the Origin check.
   */
  exemptFromToken: (req: Request) => boolean;
  /** Called with why a request was refused, for the audit trail and the log. The refusal waits for it, so the entry is written before the answer. */
  onDenied?: (req: Request, reason: 'origin' | 'token_missing' | 'token_invalid') => void | Promise<void>;
}

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

/**
 * Whether the request names this site as where it came from. Hosts are compared, not schemes: behind a TLS-terminating proxy this
 * server sees http while the browser says https, and the host is what separates sites. `null` is never an origin: a sandboxed frame
 * or a redirect chain sends `Origin: null`.
 */
export function isSameSite(req: Request, allowedOrigins: readonly string[]): boolean {
  const origin = req.get('origin');
  if (origin !== undefined) {
    if (allowedOrigins.includes(origin)) return true;
    const host = hostOf(origin);
    return host !== null && host === req.get('host');
  }
  const site = req.get('sec-fetch-site');
  return site === undefined || site === 'same-origin' || site === 'none';
}

/** The service worker replaying the offline queue sends exactly this, and cannot read the cookie to send the token. */
const isOfflineReplay = (req: Request) => req.get('x-client-channel') === 'pwa' && req.get('idempotency-key') !== undefined;

export function csrfProtection(options: CsrfOptions): RequestHandler {
  /** Records the refusal (a failure to record it does not let the request through), then answers 403. */
  const deny = (req: Request, reason: Parameters<NonNullable<CsrfOptions['onDenied']>>[1], next: (err: AppError) => void) => {
    const detail = reason === 'origin' ? { field: 'origin', reason: 'cross_origin' } : { field: CSRF_HEADER, reason: reason === 'token_missing' ? 'required' : 'invalid' };
    const error = new AppError(403, 'FORBIDDEN_CSRF', 'The request was refused: it did not come from this site.', [detail]);
    Promise.resolve()
      .then(() => options.onDenied?.(req, reason))
      .catch(() => undefined)
      .finally(() => next(error));
  };

  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const accessToken = cookies[options.accessCookie];
    if (!accessToken && !cookies[options.refreshCookie]) return next();

    if (!isSameSite(req, options.allowedOrigins)) return deny(req, 'origin', next);

    // No access cookie: the request is unauthenticated and will be answered 401; a token would be checked against nothing.
    if (!options.requireToken || !accessToken || options.exemptFromToken(req)) return next();
    // A replay from the offline queue: the Origin above is the proof (a cross-origin page cannot send these custom headers without a
    // preflight, which the CORS allow-list refuses), and it must be this very host, not an allowed other.
    if (isOfflineReplay(req) && hostOf(req.get('origin') ?? '') === req.get('host')) return next();

    const header = req.get(CSRF_HEADER);
    const cookie = cookies[CSRF_COOKIE];
    if (!header || !cookie) return deny(req, 'token_missing', next);
    if (!same(header, cookie) || !options.tokens.valid(cookie, accessToken)) return deny(req, 'token_invalid', next);
    next();
  };
}
