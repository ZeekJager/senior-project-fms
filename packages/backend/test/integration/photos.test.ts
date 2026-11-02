import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// Photos of people and vehicles (docs/photos.md): everyone sets their own, an admin anyone's, whoever manages
// drivers a driver's, whoever edits vehicles a vehicle's; only images, 2 MB at most; depot scope; audited.

const app = createApp();
const PASSWORD = 'Photo-Test-2';

/** A 1 x 1 PNG, a JPEG's and a WebP's first bytes: enough for the type check, which reads only the start. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);

type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null) {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { user, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
}

const put = (path: string, cookie: string, bytes: Buffer, type = 'image/png') =>
  request(app).put(`/api/v1${path}`).set('Cookie', cookie).attach('file', bytes, { filename: 'p', contentType: type });
const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const del = (path: string, cookie: string) => request(app).delete(`/api/v1${path}`).set('Cookie', cookie);
/** The photo bytes, whatever the type. */
const image = (url: string, cookie: string) =>
  request(app)
    .get(url)
    .set('Cookie', cookie)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

describe('photos of people', () => {
  test('anyone sets and removes their own; it shows on /auth/me and is served with its type', async () => {
    const { cookie } = await signIn(['dispatcher']);
    const set = await put('/auth/me/photo', cookie, PNG);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.photo_url).toMatch(/^\/api\/v1\/users\/[0-9a-f-]{36}\/photo\?v=\d+$/);
    const me = await get('/auth/me', cookie);
    expect(me.body.data.user.photo_url).toBe(set.body.data.photo_url);

    const file = await image(set.body.data.photo_url, cookie);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('private, max-age=86400');
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);

    // A new photo has a new URL; the old file is gone.
    const again = await put('/auth/me/photo', cookie, WEBP, 'image/webp');
    expect(again.body.data.photo_url).not.toBe(set.body.data.photo_url);
    expect((await image(again.body.data.photo_url, cookie)).headers['content-type']).toBe('image/webp');

    expect((await del('/auth/me/photo', cookie)).status).toBe(204);
    expect((await get('/auth/me', cookie)).body.data.user.photo_url).toBeNull();
    expect((await image(again.body.data.photo_url, cookie)).status).toBe(404);
    expect((await del('/auth/me/photo', cookie)).status).toBe(204);
  });

  test('only images, and at most 2 MB, whatever the file claims to be', async () => {
    const { cookie } = await signIn(['dispatcher']);
    const text = await put('/auth/me/photo', cookie, Buffer.from('hello, not an image'), 'image/png');
    expect(text.status).toBe(415);
    expect(text.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const pdf = await put('/auth/me/photo', cookie, Buffer.from('%PDF-1.4\n'), 'image/jpeg');
    expect(pdf.status).toBe(415);
    const big = await put('/auth/me/photo', cookie, Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]), 'image/jpeg');
    expect(big.status).toBe(413);
    const none = await request(app).put('/api/v1/auth/me/photo').set('Cookie', cookie).field('x', 'y');
    expect(none.status).toBe(400);
  });

  test('an admin sets anyone’s, shown in the user list; others may not; who sees a colleague’s photo', async () => {
    const admin = await signIn(['admin']);
    const depot = await createDepot();
    const colleague = await signIn(['dispatcher'], depot);
    const set = await put(`/users/${colleague.user.public_id}/photo`, admin.cookie, JPEG, 'image/jpeg');
    expect(set.status).toBe(200);
    const list = await get(`/users?search=${encodeURIComponent(colleague.user.email as string)}`, admin.cookie);
    expect(list.body.data[0].photo_url).toBe(set.body.data.photo_url);

    // A fleet manager reads users but does not change them.
    const manager = await signIn(['fleet_manager'], depot);
    expect((await put(`/users/${colleague.user.public_id}/photo`, manager.cookie, PNG)).status).toBe(403);
    expect((await image(set.body.data.photo_url, manager.cookie)).status).toBe(200);
    // A driver sees their own photo, never a colleague's.
    const driver = await signIn(['driver'], depot);
    expect((await image(set.body.data.photo_url, driver.cookie)).status).toBe(404);
    expect((await request(app).get(set.body.data.photo_url)).status).toBe(401);

    const audit = await pool.query<{ action: string; user_id: string }>(
      `SELECT action, user_id FROM audit.audit_logs WHERE entity_type = 'auth.users' AND entity_id = $1 AND action LIKE 'photo.%'`,
      [colleague.user.id],
    );
    expect(audit.rows).toEqual([{ action: 'photo.updated', user_id: admin.user.id }]);
  });

  test('whoever manages drivers sets a driver’s photo, in their depots only; it is on the driver', async () => {
    const depot = await createDepot();
    const other = await createDepot();
    const { driver } = await createDriver({ depot });
    const manager = await signIn(['depot_admin'], depot);
    const set = await put(`/drivers/${driver.public_id}/photo`, manager.cookie, PNG);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const view = await get(`/drivers/${driver.public_id}`, manager.cookie);
    expect(view.body.data.photo_url).toBe(set.body.data.photo_url);

    const elsewhere = await signIn(['depot_admin'], other);
    expect((await put(`/drivers/${driver.public_id}/photo`, elsewhere.cookie, PNG)).status).toBe(404);
    const dispatcher = await signIn(['dispatcher'], depot);
    expect((await put(`/drivers/${driver.public_id}/photo`, dispatcher.cookie, PNG)).status).toBe(403);
    expect((await del(`/drivers/${driver.public_id}/photo`, manager.cookie)).status).toBe(204);
    expect((await get(`/drivers/${driver.public_id}`, manager.cookie)).body.data.photo_url).toBeNull();
  });
});

describe('photos of vehicles', () => {
  test('set by whoever edits vehicles, on the vehicle and its list at once, served to readers in scope', async () => {
    const depot = await createDepot();
    const other = await createDepot();
    const vehicle = await createVehicle({ depot });
    const manager = await signIn(['fleet_manager'], depot);
    // Read once, so a cached view must be dropped when the photo changes.
    expect((await get(`/vehicles/${vehicle.public_id}`, manager.cookie)).body.data.photo_url).toBeNull();

    const set = await put(`/vehicles/${vehicle.public_id}/photo`, manager.cookie, JPEG, 'image/jpeg');
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.photo_url).toMatch(new RegExp(`^/api/v1/vehicles/${vehicle.public_id}/photo\\?v=\\d+$`));
    expect((await get(`/vehicles/${vehicle.public_id}`, manager.cookie)).body.data.photo_url).toBe(set.body.data.photo_url);
    const list = await get(`/vehicles?search=${encodeURIComponent(vehicle.registration_number as string)}`, manager.cookie);
    expect(list.body.data[0].photo_url).toBe(set.body.data.photo_url);

    const technician = await signIn(['technician'], depot);
    expect((await image(set.body.data.photo_url, technician.cookie)).headers['content-type']).toBe('image/jpeg');
    expect((await put(`/vehicles/${vehicle.public_id}/photo`, technician.cookie, PNG)).status).toBe(403);
    const elsewhere = await signIn(['depot_admin'], other);
    expect((await image(set.body.data.photo_url, elsewhere.cookie)).status).toBe(404);
    expect((await put(`/vehicles/${vehicle.public_id}/photo`, elsewhere.cookie, PNG)).status).toBe(404);

    expect((await del(`/vehicles/${vehicle.public_id}/photo`, manager.cookie)).status).toBe(204);
    expect((await get(`/vehicles/${vehicle.public_id}`, manager.cookie)).body.data.photo_url).toBeNull();
    expect((await image(set.body.data.photo_url, manager.cookie)).status).toBe(404);
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit.audit_logs WHERE entity_type = 'fleet.vehicles' AND entity_id = $1 AND action LIKE 'photo.%' ORDER BY id`,
      [vehicle.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['photo.updated', 'photo.removed']);
  });
});
