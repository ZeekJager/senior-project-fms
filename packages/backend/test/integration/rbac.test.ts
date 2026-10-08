// FMS-06 (SE-42): authorization and query-level scoping against the real
// database. There are no domain endpoints yet, so the test mounts its own
// routes, protected the way real ones will be, on top of the real app.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { authModule, authenticated, authorize, depotScope, publicRoute, scopeClause } from '../../src/modules/auth';
import { renderPermissionMatrix } from '../../src/modules/auth/application/permission-matrix';
import { asyncHandler } from '../../src/shared/http/async-handler';
import { notFound } from '../../src/shared/errors/app-error';
import type { AppModule } from '../../src/shared/module';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

const PASSWORD = 'Correct-Horse-7';

const ROLES: RoleName[] = [
  'admin', 'fleet_manager', 'dispatcher', 'driver', 'technician', 'depot_admin', 'finance_clerk', 'compliance_officer', 'fleet_owner',
];

/** Routes a real module would register: one per permission under test, plus a depot-scoped vehicle read. */
function testRouter(): Router {
  const router = Router();
  const ok = (_req: unknown, res: { json(b: unknown): void }) => res.json({ ok: true });

  router.get('/t/vehicles-permission', authorize('vehicle:read'), ok);
  router.post('/t/fuel-anomaly-resolve', authorize('fuel-anomaly:write'), ok);
  router.get('/t/users-permission', authorize('users:read'), ok);
  router.get('/t/either', authorize('alert:resolve', 'incident:write'), ok);
  router.get('/t/anyone-signed-in', authenticated(), ok);
  router.get('/t/open', publicRoute(), ok);

  router.get(
    '/t/vehicles',
    authorize('vehicle:read'),
    asyncHandler(async (req, res) => {
      const scope = scopeClause(depotScope(req.user), 'v.depot_id', 1);
      const rows = await pool.query(`SELECT v.public_id, v.registration_number FROM fleet.vehicles v WHERE ${scope.sql} ORDER BY v.id`, scope.params);
      res.json({ data: rows.rows });
    }),
  );
  router.get(
    '/t/vehicles/:id',
    authorize('vehicle:read'),
    asyncHandler(async (req, res) => {
      const scope = scopeClause(depotScope(req.user), 'v.depot_id', 2);
      const rows = await pool.query(
        `SELECT v.public_id, v.registration_number FROM fleet.vehicles v WHERE v.public_id = $1 AND ${scope.sql}`,
        [req.params.id, ...scope.params],
      );
      if (rows.rowCount === 0) throw notFound();
      res.json({ data: rows.rows[0] });
    }),
  );
  return router;
}

const testModule: AppModule = { name: 'rbac-test', router: testRouter() };
const app = createApp({ modules: [authModule, testModule] });

/** Signs in and returns the cookie header for later requests. */
async function signIn(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const get = (path: string, cookie?: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie ?? '');

async function grantsOf(role: RoleName): Promise<Set<string>> {
  const res = await pool.query<{ code: string }>(
    `SELECT p.code FROM auth.role_permissions rp
       JOIN auth.roles r ON r.id = rp.role_id JOIN auth.permissions p ON p.id = rp.permission_id WHERE r.name = $1`,
    [role],
  );
  return new Set(res.rows.map((r) => r.code));
}

describe('authorize against every role', () => {
  const routes: { method: 'get' | 'post'; path: string; needs: string[] }[] = [
    { method: 'get', path: '/t/vehicles-permission', needs: ['vehicle:read'] },
    { method: 'post', path: '/t/fuel-anomaly-resolve', needs: ['fuel-anomaly:write'] },
    { method: 'get', path: '/t/users-permission', needs: ['users:read'] },
    { method: 'get', path: '/t/either', needs: ['alert:resolve', 'incident:write'] },
  ];

  test.each(ROLES)('%s gets 200 exactly where its seeded grants allow and 403 everywhere else', async (role) => {
    const user = await createUser({ roles: [role], depot: await createDepot(), password: PASSWORD });
    const cookie = await signIn(user.email as string);
    const grants = await grantsOf(role);

    for (const route of routes) {
      const res = await request(app)[route.method](`/api/v1${route.path}`).set('Cookie', cookie);
      const allowed = route.needs.some((code) => grants.has(code));
      expect(res.status, `${role} ${route.method.toUpperCase()} ${route.path}`).toBe(allowed ? 200 : 403);
      if (!allowed) {
        expect(res.body.error.code).toBe('FORBIDDEN_INSUFFICIENT_ROLE');
        expect(res.body.meta.request_id).toBe(res.headers['x-request-id']);
      }
    }
    expect((await get('/t/anyone-signed-in', cookie)).status).toBe(200);
  });

  test('the seeded matrix keeps drivers out of finance and user administration, and finance clerks out of user administration', async () => {
    const driver = await createUser({ roles: ['driver'], depot: await createDepot(), password: PASSWORD });
    const clerk = await createUser({ roles: ['finance_clerk'], depot: await createDepot(), password: PASSWORD });
    const driverCookie = await signIn(driver.email as string);
    const clerkCookie = await signIn(clerk.email as string);

    expect((await request(app).post('/api/v1/t/fuel-anomaly-resolve').set('Cookie', driverCookie)).status).toBe(403);
    expect((await get('/t/users-permission', driverCookie)).status).toBe(403);
    expect((await request(app).post('/api/v1/t/fuel-anomaly-resolve').set('Cookie', clerkCookie)).status).toBe(200);
    expect((await get('/t/users-permission', clerkCookie)).status).toBe(403);
  });
});

describe('not signed in', () => {
  test.each(['/t/vehicles-permission', '/t/users-permission', '/t/either', '/t/anyone-signed-in', '/t/vehicles'])(
    '%s answers 401, never 403',
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    },
  );

  test('a route declared public stays open', async () => {
    expect((await get('/t/open')).status).toBe(200);
  });

  test('a forged cookie is 401 as well', async () => {
    expect((await get('/t/vehicles-permission', 'fms_access=not-a-token')).status).toBe(401);
  });
});

describe('permissions are read fresh on every request', () => {
  test('removing a role takes effect on the very next request, with no logout', async () => {
    const user = await createUser({ roles: ['dispatcher'], depot: await createDepot(), password: PASSWORD });
    const cookie = await signIn(user.email as string);
    expect((await get('/t/vehicles-permission', cookie)).status).toBe(200);

    await pool.query('DELETE FROM auth.user_roles WHERE user_id = $1', [user.id]);

    expect((await get('/t/vehicles-permission', cookie)).status).toBe(403);
  });

  test('a suspended user is refused at once with AUTH_ACCOUNT_DISABLED', async () => {
    const user = await createUser({ roles: ['dispatcher'], depot: await createDepot(), password: PASSWORD });
    const cookie = await signIn(user.email as string);

    await pool.query("UPDATE auth.users SET status = 'suspended' WHERE id = $1", [user.id]);

    const res = await get('/t/vehicles-permission', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
  });
});

describe('depot scoping', () => {
  async function twoDepots() {
    const depotA = await createDepot();
    const depotB = await createDepot();
    const vehicleA = await createVehicle({ depot: depotA });
    const vehicleB = await createVehicle({ depot: depotB });
    return { depotA, depotB, vehicleA, vehicleB };
  }
  const idOf = (row: Record<string, unknown>) => row.public_id as string;

  test('a dispatcher in depot A requesting a depot B vehicle by id gets 404, the same answer as for an id that does not exist', async () => {
    const { depotA, vehicleB } = await twoDepots();
    const dispatcher = await createUser({ roles: ['dispatcher'], depot: depotA, password: PASSWORD });
    const cookie = await signIn(dispatcher.email as string);

    const outOfScope = await get(`/t/vehicles/${idOf(vehicleB)}`, cookie);
    const missing = await get('/t/vehicles/00000000-0000-4000-8000-000000000000', cookie);

    expect(outOfScope.status).toBe(404);
    expect(outOfScope.body.error.code).toBe('NOT_FOUND');
    expect(missing.status).toBe(404);
    expect(outOfScope.body.error).toEqual(missing.body.error);
  });

  test('a list request from depot A never contains depot B rows', async () => {
    const { depotA, vehicleA, vehicleB } = await twoDepots();
    const dispatcher = await createUser({ roles: ['dispatcher'], depot: depotA, password: PASSWORD });
    const cookie = await signIn(dispatcher.email as string);

    const res = await get('/t/vehicles', cookie);

    const ids = res.body.data.map((v: Record<string, unknown>) => v.public_id);
    expect(res.status).toBe(200);
    expect(ids).toContain(idOf(vehicleA));
    expect(ids).not.toContain(idOf(vehicleB));
  });

  test('the same user still reads a vehicle of their own depot by id', async () => {
    const { depotA, vehicleA } = await twoDepots();
    const dispatcher = await createUser({ roles: ['dispatcher'], depot: depotA, password: PASSWORD });

    const res = await get(`/t/vehicles/${idOf(vehicleA)}`, await signIn(dispatcher.email as string));

    expect(res.status).toBe(200);
  });

  test.each(['admin', 'fleet_manager', 'fleet_owner', 'compliance_officer'] as RoleName[])(
    '%s sees vehicles of every depot',
    async (role) => {
      const { vehicleA, vehicleB } = await twoDepots();
      const user = await createUser({ roles: [role], password: PASSWORD });

      const res = await get('/t/vehicles', await signIn(user.email as string));

      const ids = res.body.data.map((v: Record<string, unknown>) => v.public_id);
      if ((await grantsOf(role)).has('vehicle:read')) {
        expect(ids).toEqual(expect.arrayContaining([idOf(vehicleA), idOf(vehicleB)]));
      } else {
        expect(res.status).toBe(403);
      }
    },
  );

  test('a depot-scoped user with no depot sees no rows at all (fails closed)', async () => {
    const { vehicleA } = await twoDepots();
    const dispatcher = await createUser({ roles: ['dispatcher'], password: PASSWORD });
    const cookie = await signIn(dispatcher.email as string);

    const list = await get('/t/vehicles', cookie);
    const byId = await get(`/t/vehicles/${idOf(vehicleA)}`, cookie);

    expect(list.body.data).toEqual([]);
    expect(byId.status).toBe(404);
  });

  test('an admin bypasses depot scope but not permissions', async () => {
    await createUser({ roles: ['admin'], password: PASSWORD });
    await pool.query("DELETE FROM auth.role_permissions WHERE role_id = (SELECT id FROM auth.roles WHERE name = 'admin') AND permission_id = (SELECT id FROM auth.permissions WHERE code = 'vehicle:read')");
    const admin = await createUser({ roles: ['admin'], password: PASSWORD });

    expect((await get('/t/vehicles', await signIn(admin.email as string))).status).toBe(403);
  });
});

describe('startup guard', () => {
  test('the real application boots: every real route declares a policy', () => {
    expect(() => createApp()).not.toThrow();
  });

  test('an application with a route that declares no permission refuses to start', () => {
    const router = Router();
    router.get('/oops', (_req, res) => res.json({ leaked: true }));

    expect(() => createApp({ modules: [{ name: 'oops', router }] })).toThrow(/GET \/api\/v1\/oops/);
  });
});

describe('permission matrix document', () => {
  test('docs/permissions.md matches the grants in the database', async () => {
    const res = await pool.query<{ role: string; permission: string }>(
      `SELECT r.name AS role, p.code AS permission FROM auth.role_permissions rp
         JOIN auth.roles r ON r.id = rp.role_id JOIN auth.permissions p ON p.id = rp.permission_id`,
    );
    const file = readFileSync(resolve(__dirname, '../../../../docs/permissions.md'), 'utf8').replace(/\r\n/g, '\n');

    expect(file).toBe(renderPermissionMatrix(res.rows));
  });
});
