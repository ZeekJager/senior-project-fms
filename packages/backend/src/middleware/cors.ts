import cors from 'cors';
import type { RequestHandler } from 'express';

/**
 * CORS (FMS-103, docs/security.md): only the origins CORS_ALLOWED_ORIGINS names, with credentials. The app's own origin needs none, and any
 * other gets no CORS headers at all, so a browser lets its page send a simple request but not read the answer, and a preflight (every
 * request with a JSON body, the CSRF token or an Idempotency-Key) fails: the request is never sent. `*` is never answered, and `null`
 * (a sandboxed frame) is not an origin.
 */
export function corsPolicy(allowedOrigins: readonly string[]): RequestHandler {
  return cors({
    origin: (origin, done) => done(null, origin !== undefined && allowedOrigins.includes(origin) ? origin : false),
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    allowedHeaders: ['Content-Type', 'Accept', 'Idempotency-Key', 'If-Match', 'X-CSRF-Token', 'X-Client-Channel'],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: 600,
  });
}
