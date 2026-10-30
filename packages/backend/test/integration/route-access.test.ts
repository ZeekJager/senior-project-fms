// FMS-59 (SE-95): access control, generated from the route registry. Every route the app serves is called here,
// anonymous and as every role, so a route added tomorrow is tested without anyone writing its test: 401 without a
// session, 403 for each role whose seeded grants lack its permission, and through for each role that holds it. A
// route that opens itself to everyone, or to anyone signed in, must be on the reviewed lists below.
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { routeRegistry, type RegisteredRoute } from '../../src/shared/authz/route-policy';
import { createDepot, createUser, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Access-Audit-1';

const ROLES: RoleName[] = [
  'admin', 'fleet_manager', 'dispatcher', 'driver', 'technician', 'depot_admin', 'finance_clerk', 'compliance_officer', 'fleet_owner',
];

/**
 * The routes anyone may call, reviewed (FMS-59). Each authenticates some other way: a password, a refresh or reset
 * token, a signed download link, a provider's webhook signature.
 */
const REVIEWED_PUBLIC = [
  'GET /health/live',
  'GET /health/ready',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/password',
  'GET /api/v1/documents/:documentId/content',
  'POST /api/v1/webhooks/telematics/:provider',
  'POST /api/v1/webhooks/fuel-card/:provider',
  'POST /api/v1/webhooks/ev/:provider',
];

/** The routes any signed-in user may call with no permission, reviewed: each answers only with the caller's own data or depots. */
const REVIEWED_AUTHENTICATED = ['GET /api/v1/auth/me', 'GET /api/v1/depots', 'GET /api/v1/depots/:depotId', 'GET /api/v1/drivers/me'];

interface Endpoint {
  method: string;
  path: string;
  kind: 'public' | 'authenticated' | 'permission' | 'none';
  /** Every set must be met, by any one code in it: `[['prediction:read'], ['maintenance:write']]` needs both. */
  needs: (readonly string[])[];
}

function endpointOf(route: RegisteredRoute): Endpoint {
  const needs = route.policies.flatMap((p) => (p.kind === 'permission' ? [p.codes] : []));
  const kind = needs.length > 0 ? 'permission' : (route.policies[0]?.kind ?? 'none');
  return { method: route.method, path: route.path, kind, needs };
}

const endpoints = routeRegistry(app).map(endpointOf);
const name = (e: Endpoint) => `${e.method} ${e.path}`;
const protectedEndpoints = endpoints.filter((e) => e.kind !== 'public');
const permissioned = endpoints.filter((e) => e.kind === 'permission');
const needsText = (e: Endpoint) => e.needs.map((set) => set.join(' or ')).join(' and ');
const holds = (grants: Set<string>, e: Endpoint) => e.needs.every((set) => set.some((code) => grants.has(code)));

/** The path with every parameter filled with an id that matches no record, so a caller who gets through finds nothing. */
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

function call(e: Endpoint, cookie?: string) {
  const req = request(app)[e.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](concrete(e.path));
  if (cookie) req.set('Cookie', cookie);
  return e.method === 'GET' || e.method === 'DELETE' ? req : req.send({});
}

async function signIn(roles: RoleName[]): Promise<string> {
  const user = await createUser({ roles, depot: await createDepot(), password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function grantsOf(role: RoleName): Promise<Set<string>> {
  const res = await pool.query<{ code: string }>(
    `SELECT p.code FROM auth.role_permissions rp
       JOIN auth.roles r ON r.id = rp.role_id JOIN auth.permissions p ON p.id = rp.permission_id WHERE r.name = $1`,
    [role],
  );
  return new Set(res.rows.map((r) => r.code));
}

describe('the route registry', () => {
  test('covers the whole API', () => {
    expect(endpoints.length).toBeGreaterThan(100);
    expect(permissioned.length).toBeGreaterThan(90);
  });

  test('a route without a permission fails CI unless it is on the reviewed lists', () => {
    expect(endpoints.filter((e) => e.kind === 'public').map(name)).toEqual(REVIEWED_PUBLIC);
    expect(endpoints.filter((e) => e.kind === 'authenticated').map(name)).toEqual(REVIEWED_AUTHENTICATED);
    // And a route that declares nothing at all stops the app from starting (route-policy.test.ts).
    expect(endpoints.filter((e) => e.kind === 'none').map(name)).toEqual([]);
  });

  test('every permission a route asks for exists, and some role holds it', async () => {
    const known = await pool.query<{ code: string; held: boolean }>(
      'SELECT p.code, EXISTS (SELECT 1 FROM auth.role_permissions rp WHERE rp.permission_id = p.id) AS held FROM auth.permissions p',
    );
    const held = new Map(known.rows.map((r) => [r.code, r.held]));
    const asked = [...new Set(permissioned.flatMap((e) => e.needs.flat()))].sort();
    expect(asked.filter((code) => !held.has(code)), 'unknown permission codes').toEqual([]);
    expect(asked.filter((code) => held.get(code) === false), 'codes no role holds').toEqual([]);
  });
});

describe('401 without a session', () => {
  test.each(protectedEndpoints.map((e) => [name(e), e] as const))('%s', async (_, e) => {
    for (const cookie of [undefined, 'fms_access=not-a-token']) {
      const res = await call(e, cookie);
      expect(res.status, `${name(e)} with ${cookie ?? 'no cookie'}`).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    }
  });
});

describe('403 for every role that lacks the permission, and through for every role that holds it', () => {
  test.each(ROLES)('%s', { timeout: 60_000 }, async (role) => {
    const cookie = await signIn([role]);
    const grants = await grantsOf(role);
    const wrong: string[] = [];
    for (const e of permissioned) {
      const res = await call(e, cookie);
      const allowed = holds(grants, e);
      const denied = res.status === 403 && res.body.error?.code === 'FORBIDDEN_INSUFFICIENT_ROLE';
      if (res.status === 401) wrong.push(`${name(e)}: 401 for a signed-in ${role}`);
      else if (allowed && denied) wrong.push(`${name(e)}: 403 although ${role} holds ${needsText(e)}`);
      else if (!allowed && !denied) wrong.push(`${name(e)}: ${res.status} although ${role} lacks ${needsText(e)}`);
    }
    for (const e of endpoints.filter((x) => x.kind === 'authenticated')) {
      const res = await call(e, cookie);
      if (res.status === 401 || res.status === 403) wrong.push(`${name(e)}: ${res.status} for a signed-in ${role}`);
    }
    expect(wrong).toEqual([]);
  });

  test('a signed-in user with no role at all is refused every permission', async () => {
    const cookie = await signIn([]);
    const through: string[] = [];
    for (const e of permissioned) {
      const res = await call(e, cookie);
      if (res.status !== 403 || res.body.error?.code !== 'FORBIDDEN_INSUFFICIENT_ROLE') through.push(`${name(e)}: ${res.status}`);
    }
    expect(through).toEqual([]);
  });

  test('each refusal is audited as access.denied, with the route pattern and the permission it needed', async () => {
    const cookie = await signIn(['driver']);
    const e = permissioned.find((x) => x.method === 'GET' && x.path === '/api/v1/users/:userId')!;
    const res = await call(e, cookie);
    expect(res.status).toBe(403);
    const audit = await pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit.audit_logs WHERE action = 'access.denied' AND correlation_id = $1",
      [res.headers['x-request-id']],
    );
    expect(audit.rows.map((r) => r.details)).toEqual([expect.objectContaining({ method: 'GET', route: '/api/v1/users/:userId', required: ['users:read'] })]);
  });
});
