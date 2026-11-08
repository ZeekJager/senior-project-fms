import { request as httpRequest, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { corsPolicy } from '../../src/middleware/cors';
import { MAX_REQUEST_BYTES } from '../../src/middleware/requestLimits';
import { securityHeaders } from '../../src/middleware/securityHeaders';
import { createUser } from '../support/factories';

// FMS-103 (docs/security.md): response headers, CORS, CSRF and request size.

const PASSWORD = 'Harden-Test-1';
const HOST = 'fms.test';
const SELF = `https://${HOST}`;
const EVIL = 'https://evil.example';

/** With the CSRF token required, as in a deployment (the rest of the suite runs without it). */
const app = createApp({ csrfToken: true });

interface Session {
  cookies: string;
  csrf: string;
  header: string[];
}

async function signIn(roles: ('admin' | 'driver')[] = ['admin']): Promise<Session> {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return session(res);
}

function session(res: Response): Session {
  const header = res.headers['set-cookie'] as unknown as string[];
  const cookies = header.map((c) => c.split(';')[0]).join('; ');
  const csrf = decodeURIComponent(header.find((c) => c.startsWith('fms_csrf='))!.split(';')[0].slice('fms_csrf='.length));
  return { cookies, csrf, header };
}

/** A write that reaches the handler and fails on its own validation (400): proof it passed the CSRF check. */
const write = (s: Session, headers: Partial<Record<string, string>> = {}) =>
  request(app).post('/api/v1/vehicles').set('Host', HOST).set('Cookie', s.cookies).set(headers as Record<string, string>).send({});

const csrfDenied = (res: Response) => res.status === 403 && res.body?.error?.code === 'FORBIDDEN_CSRF';

describe('response headers', () => {
  test('the API answers with a policy that runs nothing, frames nothing and sniffs nothing', async () => {
    const res = await request(app).get('/health/live');
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('errors and 404s carry them too', async () => {
    for (const res of [await request(app).get('/api/v1/nothing-here'), await request(app).get('/api/v1/vehicles')]) {
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  test('HSTS only in production, where TLS ends in front of the app', async () => {
    const mini = (production: boolean) => express().use(securityHeaders({ production })).get('/', (_req, res) => res.send('ok'));
    expect((await request(mini(false)).get('/')).headers['strict-transport-security']).toBeUndefined();
    expect((await request(mini(true)).get('/')).headers['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
  });

  test('the documentation page has its own policy: its scripts and styles, and calls to this origin', async () => {
    const res = await request(app).get('/api-docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
  });
});

describe('CORS', () => {
  const mini = (allowed: string[]) =>
    express()
      .use(corsPolicy(allowed))
      .all('/x', (_req, res) => res.json({ ok: true }));

  test('an origin that is not allowed gets no CORS headers: a page there cannot read the answer', async () => {
    const res = await request(mini([SELF])).get('/x').set('Origin', EVIL);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  test('its preflight is not answered, so the request with a body or a token is never sent', async () => {
    const res = await request(mini([SELF]))
      .options('/x')
      .set('Origin', EVIL)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });

  test('an allowed origin is answered by name, with credentials, never with *', async () => {
    const res = await request(mini([SELF])).get('/x').set('Origin', SELF);
    expect(res.headers['access-control-allow-origin']).toBe(SELF);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['vary']).toMatch(/Origin/);
    const preflight = await request(mini([SELF])).options('/x').set('Origin', SELF).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'x-csrf-token,idempotency-key');
    expect(preflight.headers['access-control-allow-origin']).toBe(SELF);
    expect(preflight.headers['access-control-allow-headers']).toMatch(/X-CSRF-Token/i);
  });

  test('none allowed, as in the default: no origin is answered, "null" included', async () => {
    for (const origin of [SELF, EVIL, 'null', 'http://localhost:5173']) {
      expect((await request(mini([])).get('/x').set('Origin', origin)).headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  test('the real app answers no cross-origin page by default', async () => {
    const res = await request(app).get('/health/live').set('Origin', EVIL);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CSRF', () => {
  test('sign-in sets a readable token cookie, strict and secure, beside the HttpOnly session', async () => {
    const s = await signIn();
    const csrf = s.header.find((c) => c.startsWith('fms_csrf='))!;
    expect(csrf).toMatch(/Secure/i);
    expect(csrf).toMatch(/SameSite=Strict/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(s.header.find((c) => c.startsWith('fms_access='))).toMatch(/HttpOnly/i);
    expect(s.csrf).toMatch(/^[\w-]{32}\.[\w-]{43}$/);
  });

  test('a cross-origin POST with the session is refused (the acceptance criterion), even with a valid token', async () => {
    const s = await signIn();
    const res = await write(s, { Origin: EVIL, 'X-CSRF-Token': s.csrf });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN_CSRF', details: [{ field: 'origin', reason: 'cross_origin' }] });
  });

  test('so is one that says it is cross-site without an Origin, or from "null", or from another port or host of the same machine', async () => {
    const s = await signIn();
    for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'null' }, { Origin: `https://${HOST}:8443` }, { Origin: 'https://fms.test.evil.example' }]) {
      const res = await write(s, { ...headers, 'X-CSRF-Token': s.csrf });
      expect(csrfDenied(res), JSON.stringify(headers)).toBe(true);
    }
  });

  test('from this site with the token it goes through', async () => {
    const s = await signIn();
    for (const headers of [{ Origin: SELF }, { Origin: `http://${HOST}` }, { 'Sec-Fetch-Site': 'same-origin' }, {}]) {
      const res = await write(s, { ...headers, 'X-CSRF-Token': s.csrf });
      expect(csrfDenied(res), JSON.stringify(headers)).toBe(false);
      expect(res.status).toBe(400); // the handler's own validation of the empty body
    }
  });

  test('without the token it is refused, from this site too', async () => {
    const s = await signIn();
    const res = await write(s, { Origin: SELF });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual([{ field: 'x-csrf-token', reason: 'required' }]);
  });

  test('a token that is not the cookie, or not signed for this session, is refused', async () => {
    const mine = await signIn();
    const theirs = await signIn();
    // The header differs from the cookie.
    expect((await write(mine, { Origin: SELF, 'X-CSRF-Token': theirs.csrf })).body.error?.details).toEqual([{ field: 'x-csrf-token', reason: 'invalid' }]);
    // The attacker's own valid token planted as the victim's cookie (a sibling subdomain can set cookies) and echoed: it was signed
    // for another access token.
    const planted = { ...mine, cookies: mine.cookies.replace(/fms_csrf=[^;]+/, `fms_csrf=${encodeURIComponent(theirs.csrf)}`) };
    const res = await write(planted, { Origin: SELF, 'X-CSRF-Token': theirs.csrf });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual([{ field: 'x-csrf-token', reason: 'invalid' }]);
    // A made-up token.
    expect(csrfDenied(await write({ ...mine, cookies: mine.cookies.replace(/fms_csrf=[^;]+/, 'fms_csrf=a.b') }, { Origin: SELF, 'X-CSRF-Token': 'a.b' }))).toBe(true);
  });

  test('reads are never refused: a cross-origin GET is the browser’s to block, and carries no side effect', async () => {
    const s = await signIn();
    const res = await request(app).get('/api/v1/auth/me').set('Host', HOST).set('Cookie', s.cookies).set('Origin', EVIL);
    expect(res.status).toBe(200);
  });

  test('requests with no session cookie are not CSRF targets: devices, webhooks and sign-in from anywhere', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Origin', EVIL).send({ email: 'nobody@fms.local', password: 'x'.repeat(12) });
    expect(res.status).toBe(401);
    expect(csrfDenied(res)).toBe(false);
  });

  test('sign-in, the silent refresh and sign-out need no token (it does not exist yet, or is stale), but still the Origin', async () => {
    const s = await signIn();
    const refresh = await request(app).post('/api/v1/auth/refresh').set('Host', HOST).set('Cookie', s.cookies).set('Origin', SELF);
    expect(refresh.status).toBe(200);
    // …and the token is replaced with the session.
    expect(session(refresh).csrf).not.toBe(s.csrf);
    expect((await request(app).post('/api/v1/auth/refresh').set('Host', HOST).set('Cookie', s.cookies).set('Origin', EVIL)).status).toBe(403);
    const again = await signIn();
    const out = await request(app).post('/api/v1/auth/logout').set('Host', HOST).set('Cookie', again.cookies).set('Origin', SELF);
    expect(out.status).toBe(204);
    expect((out.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('fms_csrf=;'))).toBe(true);
  });

  test('the offline queue’s replay, which cannot read the cookie, is let through when it is from this very host', async () => {
    const s = await signIn();
    const replay = { 'X-Client-Channel': 'pwa', 'Idempotency-Key': 'queued-1' };
    expect(csrfDenied(await write(s, { ...replay, Origin: SELF }))).toBe(false);
    // But not from another origin, not without an Origin, and not with only one of the two markers.
    expect(csrfDenied(await write(s, { ...replay, Origin: EVIL }))).toBe(true);
    expect(csrfDenied(await write(s, { ...replay }))).toBe(true);
    expect(csrfDenied(await write(s, { 'X-Client-Channel': 'pwa', Origin: SELF }))).toBe(true);
    expect(csrfDenied(await write(s, { 'Idempotency-Key': 'queued-1', Origin: SELF }))).toBe(true);
  });

  test('a refused write is on the audit trail as a denied access, with the route and why, and no token', async () => {
    const s = await signIn();
    const res = await write(s, { Origin: EVIL, 'X-CSRF-Token': s.csrf });
    const rows = await pool.query<{ details: Record<string, unknown>; result: string }>(
      "SELECT details, result FROM audit.audit_logs WHERE action = 'access.denied' AND correlation_id = $1",
      [res.headers['x-request-id']],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].result).toBe('denied');
    expect(rows.rows[0].details).toMatchObject({ method: 'POST', route: '/api/v1/vehicles', reason: 'csrf_origin' });
    expect(JSON.stringify(rows.rows[0].details)).not.toContain(s.csrf);
  });
});

describe('request size', () => {
  test('a JSON body over 1 MB is 413 PAYLOAD_TOO_LARGE in the usual envelope', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'a@b.c', password: 'x'.repeat(1024 * 1024 + 10) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body.meta.request_id).toBeTruthy();
  });

  test('a request that announces more than any upload can be is refused before a byte of it is read', async () => {
    // Only the headers are sent: the server answers 413 from them, as it does a real client before it has sent the body (which
    // then sees its connection closed). So the test is a raw request with a Content-Length it never fills.
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/documents', method: 'POST', headers: { 'Content-Length': String(MAX_REQUEST_BYTES + 1), 'Content-Type': 'application/octet-stream' } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.flushHeaders();
      });
      expect(answer.status).toBe(413);
      expect(JSON.parse(answer.body).error.code).toBe('PAYLOAD_TOO_LARGE');
    } finally {
      server.close();
    }
  });

  test('an upload is not refused up front: its route answers 413 once the file is too big, so the person sees why', async () => {
    const s = await signIn();
    const big = await request(app)
      .post('/api/v1/documents')
      .set('Host', HOST)
      .set('Origin', SELF)
      .set('Cookie', s.cookies)
      .set('X-CSRF-Token', s.csrf)
      .attach('file', Buffer.alloc(11 * 1024 * 1024), { filename: 'big.pdf', contentType: 'application/pdf' });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('just under the cap is the route’s business (here: not signed in)', async () => {
    const res = await request(app).post('/api/v1/documents').set('Content-Type', 'application/octet-stream').send(Buffer.alloc(64 * 1024));
    expect(res.status).toBe(401);
  });
});
