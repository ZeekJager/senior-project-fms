import type { RequestHandler } from 'express';
import helmet from 'helmet';

/** HSTS: six months, subdomains included. Only where TLS ends (production behind the load balancer): over http it would be ignored. */
const HSTS_SECONDS = 15_552_000;

/**
 * The response headers of the API (FMS-103, docs/security.md). It answers JSON, files and redirects, never a page of its own, so the
 * policy is the strictest one: no script, no style, no frame, no form, no base. Nothing is rendered from an API response, so a reflected
 * value cannot run. (The documentation page at /api-docs, off in production, and the photo and file routes set their own.)
 *
 * - Content-Security-Policy `default-src 'none'; frame-ancestors 'none'`: even an HTML body (a proxy's error page) runs nothing.
 * - X-Content-Type-Options nosniff: a JSON or file body is never guessed to be a script.
 * - X-Frame-Options DENY: no framing, for browsers that predate frame-ancestors.
 * - Referrer-Policy no-referrer; Cross-Origin-Resource-Policy same-site; Cross-Origin-Opener-Policy same-origin.
 * - Permissions-Policy: no camera, microphone or geolocation for anything the API serves.
 * - Strict-Transport-Security in production; no X-Powered-By.
 */
export function securityHeaders(options: { production: boolean }): RequestHandler {
  const base = helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    strictTransportSecurity: options.production ? { maxAge: HSTS_SECONDS, includeSubDomains: true } : false,
    // Deprecated and harmful in old browsers: helmet turns it off with 0.
    xXssProtection: true,
  });
  return (req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    base(req, res, next);
  };
}

/** The policy for the API documentation page (non-production): its own scripts and styles, and calls to this origin. */
export const API_DOCS_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
