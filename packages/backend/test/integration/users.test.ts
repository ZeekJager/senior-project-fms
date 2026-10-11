import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { UserAdminService } from '../../src/modules/auth/application/user-admin.service';
import { UserAdminRepository } from '../../src/modules/auth/infrastructure/user-admin.repository';
import { depotDirectory } from '../../src/modules/fleet';
import type { DomainEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { createDepot, createUser, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Users-Test-2026';
const NEW_PASSWORD = 'Brand-New-Secret-77';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type User = Awaited<ReturnType<typeof createUser>>;

function cookieOf(res: Response): string {
  return ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');
}

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<{ user: User; cookie: string }> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { user, cookie: cookieOf(res) };
}

const login = (email: string, password: string) => request(app).post('/api/v1/auth/login').send({ email, password });

const api = {
  get: (path: string, cookie = '') => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie = '') => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie = '') => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

/** Collects the user events published during `fn`. */
async function capture(fn: () => Promise<unknown>): Promise<DomainEvent[]> {
  const seen: DomainEvent[] = [];
  const offs = ['UserCreated', 'UserRoleChanged', 'UserDeactivated', 'UserAccountChanged'].map((t) =>
    eventBus.subscribe(t, (e) => {
      seen.push(e);
    }),
  );
  try {
    await fn();
  } finally {
    offs.forEach((off) => off());
  }
  return seen;
}

async function publicIdOf(user: User): Promise<string> {
  const res = await pool.query<{ public_id: string }>('SELECT public_id FROM auth.users WHERE id = $1', [user.id]);
  return res.rows[0].public_id;
}

async function auditActions(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>(
    'SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

/** Gives fleet_manager users:write for this test (rolled back), so requests get past authorize to the escalation rules. */
async function letFleetManagersWriteUsers() {
  await pool.query(
    `INSERT INTO auth.role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM auth.roles r, auth.permissions p WHERE r.name = 'fleet_manager' AND p.code = 'users:write'
     ON CONFLICT DO NOTHING`,
  );
}

describe('POST /users', () => {
  test('an admin creates an account without a password and gets a one-time setup link; the user sets a password and signs in', async () => {
    const { cookie } = await signIn(['admin']);
    const depot = await createDepot();
    let res!: Response;
    const events = await capture(async () => {
      res = await api.post(
        '/users',
        { email: ' New.Dispatcher@Test.FMS ', full_name: 'Hanna Dispatcher', phone: '+251 911 000111', depot_id: depot.public_id, roles: ['dispatcher'] },
        cookie,
      );
    });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.location).toBe(`/api/v1/users/${res.body.data.id}`);
    expect(res.body.data).toMatchObject({
      email: 'new.dispatcher@test.fms',
      full_name: 'Hanna Dispatcher',
      depot_id: depot.public_id,
      status: 'active',
      roles: ['dispatcher'],
      has_password: false,
    });
    expect(res.body.data).not.toHaveProperty('password_hash');
    const setup = res.body.meta.password_setup;
    expect(setup).toMatchObject({ purpose: 'setup', token: expect.stringMatching(/^[\w-]{43}$/) });
    expect(new Date(setup.expires_at).getTime() - Date.now()).toBeGreaterThan(71 * 3600 * 1000);
    expect(events.map((e) => e.type)).toEqual(['UserCreated', 'UserAccountChanged']);
    expect(events[0].payload).toEqual({ user_id: res.body.data.id, roles: ['dispatcher'] });
    expect(await auditActions(res)).toEqual(['INSERT auth.users', 'ROLE_CHANGE auth.user_roles', 'INSERT auth.password_tokens']);
    // Only the hash is stored.
    expect((await pool.query('SELECT 1 FROM auth.password_tokens WHERE token_hash = $1', [setup.token])).rowCount).toBe(0);

    // No password yet: login fails like a wrong password.
    expect((await login('new.dispatcher@test.fms', NEW_PASSWORD)).status).toBe(401);
    const weak = await api.post('/auth/password', { token: setup.token, password: 'new.dispatcher-12345' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.details).toEqual([{ field: 'password', reason: 'contains_email' }]);
    expect((await api.post('/auth/password', { token: setup.token, password: NEW_PASSWORD })).status).toBe(204);
    expect((await login('new.dispatcher@test.fms', NEW_PASSWORD)).status).toBe(200);
    // The link is single use.
    const again = await api.post('/auth/password', { token: setup.token, password: 'Another-Secret-88' });
    expect(again.status).toBe(400);
    expect(again.body.error.details).toEqual([{ field: 'token', reason: 'invalid_or_expired' }]);
  });

  test('a duplicate email is 409; depot-scoped roles need a depot; unknown roles and unknown fields are 400', async () => {
    const { cookie } = await signIn(['admin']);
    const existing = await createUser();
    const dup = await api.post('/users', { email: (existing.email as string).toUpperCase(), full_name: 'X', roles: ['fleet_owner'] }, cookie);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT_DUPLICATE');

    const noDepot = await api.post('/users', { email: 'nodepot@test.fms', full_name: 'X', roles: ['driver'] }, cookie);
    expect(noDepot.status).toBe(400);
    expect(noDepot.body.error.details).toEqual([{ field: 'depot_id', reason: 'required' }]);

    const unknown = await api.post('/users', { email: 'unknown@test.fms', full_name: 'X', roles: ['fleet_owner', 'superuser'] }, cookie);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual([{ field: 'roles.1', reason: 'references_missing_record' }]);

    const extra = await api.post('/users', { email: 'extra@test.fms', full_name: 'X', roles: ['fleet_owner'], password_hash: 'x' }, cookie);
    expect(extra.status).toBe(400);
    expect(extra.body.error.details).toEqual([{ field: 'password_hash', reason: 'not_writable' }]);
  });

  test('a fleet manager cannot create users (403), and cannot grant admin even holding users:write', async () => {
    const { cookie } = await signIn(['fleet_manager']);
    expect((await api.post('/users', { email: 'fm-made@test.fms', full_name: 'X', roles: ['admin'] }, cookie)).status).toBe(403);

    await letFleetManagersWriteUsers();
    const escalation = await api.post('/users', { email: 'fm-admin@test.fms', full_name: 'X', roles: ['admin'] }, cookie);
    expect(escalation.status).toBe(403);
    expect(escalation.body.error).toMatchObject({ code: 'FORBIDDEN_INSUFFICIENT_ROLE', details: [{ field: 'roles', reason: 'escalation' }] });
    expect((await pool.query("SELECT 1 FROM auth.users WHERE email = 'fm-admin@test.fms'")).rowCount).toBe(0);
    // A role within the caller's own permissions is fine.
    const depot = await createDepot();
    const ok = await api.post('/users', { email: 'fm-dispatcher@test.fms', full_name: 'X', depot_id: depot.public_id, roles: ['dispatcher'] }, cookie);
    expect(ok.status).toBe(201);
  });
});

describe('PATCH /users/{id}', () => {
  test('changing roles is audited with the roles before and after, and publishes UserRoleChanged', async () => {
    const { cookie } = await signIn(['admin']);
    const depot = await createDepot();
    const target = await createUser({ roles: ['dispatcher'], depot });
    const id = await publicIdOf(target);
    let res!: Response;
    const events = await capture(async () => {
      res = await api.patch(`/users/${id}`, { roles: ['dispatcher', 'depot_admin'] }, cookie);
    });
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual(['depot_admin', 'dispatcher']);
    expect(events.map((e) => [e.type, e.payload])).toEqual([['UserRoleChanged', { user_id: id, added: ['depot_admin'], removed: [] }]]);
    const audit = await pool.query("SELECT old_values, new_values FROM audit.audit_logs WHERE correlation_id = $1 AND action = 'ROLE_CHANGE'", [
      res.headers['x-request-id'],
    ]);
    expect(audit.rows).toEqual([{ old_values: { roles: ['dispatcher'] }, new_values: { roles: ['depot_admin', 'dispatcher'] } }]);
  });

  test('nobody changes their own roles or deactivates themselves', async () => {
    const { user, cookie } = await signIn(['admin']);
    const id = await publicIdOf(user);
    const roles = await api.patch(`/users/${id}`, { roles: ['admin', 'fleet_owner'] }, cookie);
    expect(roles.status).toBe(403);
    expect(roles.body.error.details).toEqual([{ field: 'roles', reason: 'own_roles' }]);
    expect((await api.patch(`/users/${id}`, { status: 'inactive' }, cookie)).status).toBe(409);
    // Their own name is fine.
    expect((await api.patch(`/users/${id}`, { full_name: 'Renamed Admin' }, cookie)).status).toBe(200);
  });

  test('without the admin role, nobody grants, removes or manages admin (escalation)', async () => {
    await letFleetManagersWriteUsers();
    const { cookie } = await signIn(['fleet_manager']);
    const plain = await createUser({ roles: ['dispatcher'], depot: await createDepot() });
    const admin = await createUser({ roles: ['admin'] });

    const grant = await api.patch(`/users/${await publicIdOf(plain)}`, { roles: ['dispatcher', 'admin'] }, cookie);
    expect(grant.status).toBe(403);
    expect(grant.body.error.details).toEqual([{ field: 'roles', reason: 'escalation' }]);
    // Deactivating an admin, changing its email or resetting its password is taking it over.
    const adminId = await publicIdOf(admin);
    for (const body of [{ status: 'inactive' }, { email: 'taken-over@test.fms' }, { roles: ['fleet_owner'] }]) {
      expect((await api.patch(`/users/${adminId}`, body, cookie)).status, JSON.stringify(body)).toBe(403);
    }
    expect((await api.post(`/users/${adminId}/password-reset`, {}, cookie)).status).toBe(403);
    const roles = await pool.query('SELECT r.name FROM auth.user_roles ur JOIN auth.roles r ON r.id = ur.role_id WHERE ur.user_id = $1', [plain.id]);
    expect(roles.rows).toEqual([{ name: 'dispatcher' }]);
    // Within its own permissions it manages users.
    expect((await api.patch(`/users/${await publicIdOf(plain)}`, { full_name: 'Renamed Dispatcher' }, cookie)).status).toBe(200);
  });

  test('deactivating a user ends their sessions within the same request', async () => {
    const { cookie } = await signIn(['admin']);
    const member = await signIn(['fleet_owner']);
    expect((await api.get('/auth/me', member.cookie)).status).toBe(200);

    let res!: Response;
    const events = await capture(async () => {
      res = await api.patch(`/users/${await publicIdOf(member.user)}`, { status: 'inactive' }, cookie);
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('inactive');
    expect(events.map((e) => e.type)).toEqual(['UserDeactivated', 'UserAccountChanged']);
    expect(events[0].payload).toMatchObject({ sessions_revoked: 1 });

    const open = await pool.query('SELECT 1 FROM auth.refresh_sessions WHERE user_id = $1 AND revoked_at IS NULL', [member.user.id]);
    expect(open.rowCount).toBe(0);
    const me = await api.get('/auth/me', member.cookie);
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
    expect((await api.post('/auth/refresh', {}, member.cookie)).status).toBeGreaterThanOrEqual(401);
    expect((await login(member.user.email as string, PASSWORD)).status).toBe(403);
  });

  test('the last active admin keeps the role (two admins demoting each other at once)', async () => {
    const target = await createUser({ roles: ['admin'] });
    // Every other admin is gone (rolled back after the test): what the second
    // of two concurrent demotions sees once the first has committed.
    await pool.query(
      `UPDATE auth.users SET status = 'inactive'
        WHERE id <> $1 AND id IN (SELECT ur.user_id FROM auth.user_roles ur JOIN auth.roles r ON r.id = ur.role_id WHERE r.name = 'admin')`,
      [target.id],
    );
    const service = new UserAdminService({
      db: pool,
      users: new UserAdminRepository(),
      depots: depotDirectory,
      events: eventBus,
      accountChangedEvent: 'UserAccountChanged',
    });
    const perms = await pool.query<{ code: string }>(
      "SELECT p.code FROM auth.role_permissions rp JOIN auth.roles r ON r.id = rp.role_id JOIN auth.permissions p ON p.id = rp.permission_id WHERE r.name = 'admin'",
    );
    const caller = {
      user: { id: null, publicId: 'another-admin', roles: ['admin'], permissions: perms.rows.map((r) => r.code), depotId: null },
      correlationId: 'test-last-admin',
    };
    const id = await publicIdOf(target);
    await expect(service.update(caller, id, { roles: ['fleet_owner'] })).rejects.toMatchObject({ status: 409, details: [{ reason: 'last_admin' }] });
    await expect(service.update(caller, id, { status: 'suspended' })).rejects.toMatchObject({ status: 409 });
  });

  test('an unknown user is 404, as is an id that is not a UUID', async () => {
    const { cookie } = await signIn(['admin']);
    expect((await api.patch('/users/00000000-0000-4000-8000-000000000000', { full_name: 'X' }, cookie)).status).toBe(404);
    expect((await api.patch('/users/42', { full_name: 'X' }, cookie)).status).toBe(404);
  });
});

describe('password links', () => {
  test("an admin issues a reset link; setting the password ends the user's sessions; an older link stops working", async () => {
    const { cookie } = await signIn(['admin']);
    const member = await signIn(['fleet_owner']);
    const id = await publicIdOf(member.user);

    const first = await api.post(`/users/${id}/password-reset`, {}, cookie);
    expect(first.status).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body.data).toMatchObject({ purpose: 'reset' });
    expect(new Date(first.body.data.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(3600 * 1000);
    const second = await api.post(`/users/${id}/password-reset`, {}, cookie);

    expect((await api.post('/auth/password', { token: first.body.data.token, password: NEW_PASSWORD })).status).toBe(400);
    const set = await api.post('/auth/password', { token: second.body.data.token, password: NEW_PASSWORD });
    expect(set.status).toBe(204);
    expect(await auditActions(set)).toEqual(['UPDATE auth.users', 'auth.password_set auth.users']);

    expect((await api.get('/auth/me', member.cookie)).status).toBe(401);
    expect((await login(member.user.email as string, PASSWORD)).status).toBe(401);
    expect((await login(member.user.email as string, NEW_PASSWORD)).status).toBe(200);
  });

  test('an expired link is refused', async () => {
    const { cookie } = await signIn(['admin']);
    const member = await createUser({ roles: ['fleet_owner'] });
    const link = await api.post(`/users/${await publicIdOf(member)}/password-reset`, {}, cookie);
    await pool.query(
      "UPDATE auth.password_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1",
      [member.id],
    );
    const res = await api.post('/auth/password', { token: link.body.data.token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'token', reason: 'invalid_or_expired' }]);
  });
});

describe('GET /users and /roles', () => {
  test('users:read lists users with filters; other roles get 403', async () => {
    const { cookie } = await signIn(['compliance_officer']);
    const depot = await createDepot();
    await createUser({ roles: ['technician'], depot, fullName: 'Zebiba Technician' });
    const res = await api.get(`/users?role=technician&depot_id=${depot.public_id}`, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.map((u: { full_name: string }) => u.full_name)).toEqual(['Zebiba Technician']);
    expect(res.body.meta).toMatchObject({ page: 1, total_items: 1 });
    expect(res.body.data[0]).not.toHaveProperty('password_hash');

    const search = await api.get('/users?search=zebiba', cookie);
    expect(search.body.data.map((u: { full_name: string }) => u.full_name)).toContain('Zebiba Technician');
    expect((await api.get('/users', (await signIn(['dispatcher'], depot)).cookie)).status).toBe(403);
    expect((await api.get('/users')).status).toBe(401);
  });

  test('GET /roles lists the active roles with their permissions', async () => {
    const { cookie } = await signIn(['fleet_manager']);
    const res = await api.get('/roles', cookie);
    expect(res.status).toBe(200);
    const admin = res.body.data.find((r: { name: string }) => r.name === 'admin');
    expect(admin.permissions).toEqual(expect.arrayContaining(['users:write', 'roles:read']));
    expect(res.body.data.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(['driver', 'fleet_manager']));
    expect((await api.get('/roles', (await signIn(['driver'], await createDepot())).cookie)).status).toBe(403);
  });
});
