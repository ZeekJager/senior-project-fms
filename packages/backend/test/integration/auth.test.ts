import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import request, { type Response } from 'supertest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { TokenService } from '../../src/modules/auth/application/token.service';
import { createDepot, createUser, type CreateUserOptions } from '../support/factories';

const app = createApp();
const PASSWORD = 'Correct-Horse-7';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Cookie {
  value: string;
  attributes: string[];
}

/** Set-Cookie headers by cookie name. */
function cookies(res: Response): Record<string, Cookie> {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const out: Record<string, Cookie> = {};
  for (const line of header ?? []) {
    const [pair, ...attributes] = line.split(';').map((p) => p.trim());
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = { value: decodeURIComponent(pair.slice(eq + 1)), attributes };
  }
  return out;
}

function cookieHeader(values: { access?: string; refresh?: string }): string {
  return [
    values.access !== undefined ? `fms_access=${values.access}` : null,
    values.refresh !== undefined ? `fms_refresh=${values.refresh}` : null,
  ]
    .filter(Boolean)
    .join('; ');
}

async function signUp(options: CreateUserOptions = {}) {
  return createUser({ roles: ['dispatcher'], password: PASSWORD, ...options });
}

async function login(email: string, password = PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').set('User-Agent', 'vitest-agent').send({ email, password });
  const c = cookies(res);
  return { res, access: c.fms_access?.value, refresh: c.fms_refresh?.value };
}

async function auditFor(res: Response) {
  const rows = await pool.query(
    `SELECT action, user_id, entity_id, host(ip_address) AS ip, details
       FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id`,
    [res.headers['x-request-id']],
  );
  return rows.rows;
}

describe('POST /auth/login', () => {
  test('correct credentials return 200 with both cookies HttpOnly, Secure and SameSite=Strict', async () => {
    const user = await signUp();
    const { res, access, refresh } = await login(user.email as string);

    expect(res.status).toBe(200);
    const c = cookies(res);
    for (const name of ['fms_access', 'fms_refresh']) {
      expect(c[name].attributes).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict']));
    }
    expect(c.fms_access.attributes).toContain('Path=/');
    expect(c.fms_refresh.attributes).toContain('Path=/api/v1/auth');
    expect(c.fms_access.attributes).toContain('Max-Age=900');
    expect(c.fms_refresh.attributes).toContain(`Max-Age=${7 * 24 * 3600}`);
    expect(res.headers['cache-control']).toBe('no-store');

    // Tokens only in cookies; only public ids in the body.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(access);
    expect(body).not.toContain(refresh);
    expect(res.body.data.user).toMatchObject({ id: user.public_id, email: user.email, status: 'active' });
    expect(res.body.data.user.id).toMatch(UUID);
    expect(res.body.data.roles).toEqual(['dispatcher']);
    expect(res.body.data.permissions).toContain('trip:write');
    expect(res.body.data.user.last_login_at).not.toBeNull();
  });

  test('email matching is case-insensitive', async () => {
    const user = await signUp();
    const { res } = await login((user.email as string).toUpperCase());
    expect(res.status).toBe(200);
  });

  test('wrong password and unknown email get the same 401 AUTH_INVALID_CREDENTIALS', async () => {
    const user = await signUp();
    const wrong = await login(user.email as string, 'wrong-password');
    const unknown = await login('nobody-here@test.fms');

    for (const res of [wrong.res, unknown.res]) {
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(wrong.res.body.error).toEqual(unknown.res.body.error);
    expect(wrong.res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  test('a user whose status is not active gets 403 AUTH_ACCOUNT_DISABLED, but only with the right password', async () => {
    for (const status of ['inactive', 'suspended', 'locked'] as const) {
      const user = await signUp({ status });
      const right = await login(user.email as string);
      expect(right.res.status).toBe(403);
      expect(right.res.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
      expect(right.res.headers['set-cookie']).toBeUndefined();

      const wrong = await login(user.email as string, 'wrong-password');
      expect(wrong.res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    }
  });

  test('the 6th failed login within 15 minutes returns 429 RATE_LIMITED, even with the right password', async () => {
    const user = await signUp();
    for (let i = 0; i < 5; i++) {
      expect((await login(user.email as string, 'wrong-password')).res.status).toBe(401);
    }
    const sixth = await login(user.email as string);
    expect(sixth.res.status).toBe(429);
    expect(sixth.res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(sixth.res.headers['retry-after'])).toBeGreaterThan(0);
    expect(sixth.res.headers['set-cookie']).toBeUndefined();
  });

  test('a successful login resets the failure count', async () => {
    const user = await signUp();
    for (let i = 0; i < 4; i++) await login(user.email as string, 'wrong-password');
    expect((await login(user.email as string)).res.status).toBe(200);
    for (let i = 0; i < 4; i++) await login(user.email as string, 'wrong-password');
    expect((await login(user.email as string)).res.status).toBe(200);
  });

  test('every attempt writes an audit row with IP and user agent', async () => {
    const user = await signUp();
    const ok = await login(user.email as string);
    const bad = await login(user.email as string, 'wrong-password');
    const unknown = await login('ghost@test.fms');
    const disabled = await signUp({ status: 'suspended' });
    const blocked = await login(disabled.email as string);

    const [success] = await auditFor(ok.res);
    expect(success).toMatchObject({ action: 'auth.login_succeeded', user_id: user.id, entity_id: user.id });
    expect(success.ip).toBeTruthy();
    expect(success.details.user_agent).toBe('vitest-agent');

    const [failure] = await auditFor(bad.res);
    expect(failure).toMatchObject({ action: 'auth.login_failed', user_id: null, entity_id: user.id });
    expect(failure.details).toMatchObject({ reason: 'invalid_credentials', user_agent: 'vitest-agent' });

    const [ghost] = await auditFor(unknown.res);
    expect(ghost).toMatchObject({ action: 'auth.login_failed', entity_id: null });
    expect(ghost.details.email).toBe('ghost@test.fms');

    const [denied] = await auditFor(blocked.res);
    expect(denied).toMatchObject({ action: 'auth.login_failed', entity_id: disabled.id });
    expect(denied.details).toMatchObject({ reason: 'account_disabled', status: 'suspended' });

    // The password never reaches the audit trail.
    const all = JSON.stringify([success, failure, ghost, denied]);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('wrong-password');
  });

  test('a throttled attempt is audited too', async () => {
    const user = await signUp();
    for (let i = 0; i < 5; i++) await login(user.email as string, 'wrong-password');
    const [row] = await auditFor((await login(user.email as string)).res);
    expect(row.action).toBe('auth.login_throttled');
  });

  test('a malformed body returns 400 VALIDATION_FAILED without echoing the input', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['email', 'password']);
    expect(JSON.stringify(res.body)).not.toContain('not-an-email');
  });

  test('the refresh token is stored only as its SHA-256 hash, in a new session family', async () => {
    const user = await signUp();
    const { refresh } = await login(user.email as string);
    const res = await pool.query('SELECT token_hash, family_id FROM auth.refresh_sessions WHERE user_id = $1', [user.id]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].token_hash).toBe(createHash('sha256').update(refresh!).digest('hex'));
    expect(res.rows[0].family_id).toMatch(UUID);
  });
});

describe('GET /auth/me', () => {
  test("returns the home depot's public id, resolved by the fleet module, and null without a depot", async () => {
    const depot = await createDepot();
    const scoped = await signUp({ depot });
    const unscoped = await signUp({ roles: ['admin'] });

    const withDepot = await login(scoped.email as string);
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookieHeader({ access: withDepot.access }));
    expect(me.body.data.user.depot_id).toBe(depot.public_id);
    expect(withDepot.res.body.data.user.depot_id).toBe(depot.public_id);

    const noDepot = await login(unscoped.email as string);
    expect(noDepot.res.body.data.user.depot_id).toBeNull();
  });

  test('returns the user, roles and permission codes', async () => {
    const user = await signUp({ roles: ['dispatcher', 'driver'] });
    const { access } = await login(user.email as string);
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookieHeader({ access }));

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.public_id);
    expect(res.body.data.roles).toEqual(['dispatcher', 'driver']);
    expect(res.body.data.permissions).toEqual([...res.body.data.permissions].sort());
    expect(res.body.data.permissions).toContain('dvir:write');
    expect(res.body.meta.request_id).toBe(res.headers['x-request-id']);
    expect(Object.keys(res.body.data.user)).not.toContain('password_hash');
  });

  test('without an access cookie is 401 AUTH_TOKEN_INVALID', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  test('a garbage token is 401 AUTH_TOKEN_INVALID', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookieHeader({ access: 'abc.def.ghi' }));
    expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  test('an expired access token is 401 AUTH_TOKEN_EXPIRED', async () => {
    const user = await signUp();
    await login(user.email as string);
    const { rows } = await pool.query('SELECT family_id FROM auth.refresh_sessions WHERE user_id = $1', [user.id]);
    const anHourAgo = Date.now() - 60 * 60 * 1000;
    const stale = await new TokenService(config.jwtSecret, () => anHourAgo).signAccessToken({
      userId: user.public_id as string,
      sessionFamilyId: rows[0].family_id,
    });
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookieHeader({ access: stale }));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  test('a user disabled after login is cut off at once with 403 AUTH_ACCOUNT_DISABLED', async () => {
    const user = await signUp();
    const { access } = await login(user.email as string);
    await pool.query("UPDATE auth.users SET status = 'suspended' WHERE id = $1", [user.id]);
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookieHeader({ access }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
  });
});

describe('POST /auth/refresh', () => {
  test('rotates the refresh token and issues a new access token', async () => {
    const user = await signUp();
    const first = await login(user.email as string);

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh: first.refresh }));
    expect(res.status).toBe(200);
    const c = cookies(res);
    expect(c.fms_refresh.value).not.toBe(first.refresh);
    expect(c.fms_access.value).toBeTruthy();
    expect(res.body.data.user.id).toBe(user.public_id);

    const sessions = await pool.query(
      'SELECT revoked_at IS NOT NULL AS revoked, family_id FROM auth.refresh_sessions WHERE user_id = $1 ORDER BY id',
      [user.id],
    );
    expect(sessions.rows.map((r) => r.revoked)).toEqual([true, false]);
    expect(sessions.rows[0].family_id).toBe(sessions.rows[1].family_id);

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookieHeader({ access: c.fms_access.value }));
    expect(me.status).toBe(200);
  });

  test('replaying a rotated refresh token returns 401 AUTH_TOKEN_REVOKED and revokes the family', async () => {
    const user = await signUp();
    const first = await login(user.email as string);
    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh: first.refresh }));
    const second = cookies(rotated);

    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh: first.refresh }));
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('AUTH_TOKEN_REVOKED');
    // The failed refresh clears the browser's cookies.
    expect(cookies(replay).fms_refresh.attributes.join(';')).toMatch(/Expires=Thu, 01 Jan 1970/);

    // The legitimate holder's newer token and access token are dead too.
    const legit = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh: second.fms_refresh.value }));
    expect(legit.body.error.code).toBe('AUTH_TOKEN_REVOKED');
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookieHeader({ access: second.fms_access.value }));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('AUTH_TOKEN_REVOKED');

    const live = await pool.query('SELECT count(*)::int AS n FROM auth.refresh_sessions WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
    expect(live.rows[0].n).toBe(0);
    const [audit] = await auditFor(replay);
    expect(audit).toMatchObject({ action: 'auth.refresh_reuse_detected', entity_id: user.id });
  });

  test('another session of the same user survives a reuse in a different family', async () => {
    const user = await signUp();
    const laptop = await login(user.email as string);
    const phone = await login(user.email as string);
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh: laptop.refresh }));
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh: laptop.refresh }));

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh: phone.refresh }));
    expect(res.status).toBe(200);
  });

  test('a missing or unknown refresh token is 401 AUTH_TOKEN_INVALID', async () => {
    const none = await request(app).post('/api/v1/auth/refresh');
    expect(none.body.error.code).toBe('AUTH_TOKEN_INVALID');
    const unknown = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh: 'made-up' }));
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  test('an expired refresh session is 401 AUTH_TOKEN_EXPIRED', async () => {
    const user = await signUp();
    const { refresh } = await login(user.email as string);
    await pool.query(
      `UPDATE auth.refresh_sessions
          SET issued_at = CURRENT_TIMESTAMP - interval '8 days', expires_at = CURRENT_TIMESTAMP - interval '1 day'
        WHERE user_id = $1`,
      [user.id],
    );
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh }));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  test('account status is checked on refresh: 403 AUTH_ACCOUNT_DISABLED', async () => {
    const user = await signUp();
    const { refresh } = await login(user.email as string);
    await pool.query("UPDATE auth.users SET status = 'locked' WHERE id = $1", [user.id]);
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
  });
});

describe('POST /auth/logout', () => {
  test('revokes the session, clears both cookies and is audited', async () => {
    const user = await signUp();
    const { access, refresh } = await login(user.email as string);

    const res = await request(app).post('/api/v1/auth/logout').set('Cookie', cookieHeader({ refresh }));
    expect(res.status).toBe(204);
    const c = cookies(res);
    expect(c.fms_access.value).toBe('');
    expect(c.fms_refresh.value).toBe('');
    expect(c.fms_refresh.attributes).toContain('Path=/api/v1/auth');

    const [audit] = await auditFor(res);
    expect(audit).toMatchObject({ action: 'auth.logout', user_id: user.id });
    expect(audit.details.user_agent).toBeDefined();

    const again = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh }));
    expect(again.body.error.code).toBe('AUTH_TOKEN_REVOKED');
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookieHeader({ access }));
    expect(me.body.error.code).toBe('AUTH_TOKEN_REVOKED');
  });

  test('without a session it still returns 204', async () => {
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(204);
  });
});
