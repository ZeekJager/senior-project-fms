import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { DocumentUrlSigner } from '../../src/modules/fleet/application/document-url';
import type { DomainEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';
import { TEST_STORAGE_DIR } from '../support/test-env';

const app = createApp();
const PASSWORD = 'Document-Test-1';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const TEXT = Buffer.from('just some text, not a pdf at all\n');

type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signInWithUser(roles: RoleName[], depot: Depot | null = null) {
  const user = await createUser({ roles, depot, password: PASSWORD });
  return { user, cookie: await login(user.email as string) };
}

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}
const signIn = async (roles: RoleName[], depot: Depot | null = null) => (await signInWithUser(roles, depot)).cookie;

function upload(cookie: string, fields: Record<string, string>, file?: { bytes: Buffer; name: string; type?: string }) {
  let req = request(app).post('/api/v1/documents').set('Cookie', cookie);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  if (file) req = req.attach('file', file.bytes, { filename: file.name, contentType: file.type ?? 'application/octet-stream' });
  return req;
}

const vehicleDoc = (vehicle: Record<string, unknown>, extra: Record<string, string> = {}) => ({
  owner_type: 'vehicle',
  owner_id: String(vehicle.public_id),
  document_type: 'registration',
  ...extra,
});

function storedFiles(): string[] {
  if (!existsSync(TEST_STORAGE_DIR)) return [];
  return readdirSync(TEST_STORAGE_DIR, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string; new_values: Record<string, unknown> }>(
    'SELECT action, entity_type, new_values FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows;
}

const getContent = (url: string) => request(app).get(url).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

describe('POST /documents', () => {
  test('stores a file by its content type, never its name or claim; returns metadata without the storage key', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);
    const before = storedFiles().length;

    const res = await upload(cookie, vehicleDoc(vehicle, { expires_on: '2027-06-30' }), { bytes: PNG, name: 'C:\\scans\\reg.bin' });

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/documents/${res.body.data.id}`);
    expect(res.body.data).toMatchObject({
      owner_type: 'vehicle',
      owner_id: vehicle.public_id,
      document_type: 'registration',
      original_filename: 'reg.bin',
      content_type: 'image/png',
      size_bytes: PNG.length,
      sha256: createHash('sha256').update(PNG).digest('hex'),
      expires_on: '2027-06-30',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/storage_key|documents\/\d{4}\//);
    expect(storedFiles().length).toBe(before + 1);

    const [audit] = await auditRows(res);
    expect(audit).toMatchObject({ action: 'INSERT', entity_type: 'document.documents' });
    expect(audit.new_values.storage_key).toBe('[REDACTED]');
  });

  test('JPEG and PDF are accepted too', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);
    expect((await upload(cookie, vehicleDoc(vehicle), { bytes: JPEG, name: 'a.jpg' })).body.data.content_type).toBe('image/jpeg');
    expect((await upload(cookie, vehicleDoc(vehicle), { bytes: PDF, name: 'a.pdf' })).body.data.content_type).toBe('application/pdf');
  });

  test('a .txt renamed .pdf returns 415 UNSUPPORTED_MEDIA_TYPE and stores nothing', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const before = storedFiles().length;
    const res = await upload(await signIn(['depot_admin'], depot), vehicleDoc(vehicle), { bytes: TEXT, name: 'insurance.pdf', type: 'application/pdf' });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(storedFiles().length).toBe(before);
  });

  test('a 15 MB file returns 413 PAYLOAD_TOO_LARGE', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const big = Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)]);
    const res = await upload(await signIn(['depot_admin'], depot), vehicleDoc(vehicle), { bytes: big, name: 'big.png' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('a malformed multipart body is 400, not a server error', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const res = await upload(await signIn(['depot_admin'], depot), vehicleDoc(vehicle), { bytes: PNG, name: 'bad\u0007name.png' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'body', reason: 'malformed_multipart' }]);
  });

  test('validates the form: no file, an unknown owner type or field, a vehicle outside the scope', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const cookie = await signIn(['depot_admin'], a);
    const mine = await createVehicle({ depot: a });
    const theirs = await createVehicle({ depot: b });

    expect((await upload(cookie, vehicleDoc(mine))).body.error.details).toEqual([{ field: 'file', reason: 'required' }]);
    const badOwner = await upload(cookie, { ...vehicleDoc(mine), owner_type: 'trip' }, { bytes: PNG, name: 'x.png' });
    expect(badOwner.body.error).toMatchObject({ code: 'VALIDATION_INVALID_ENUM', details: [{ field: 'owner_type', reason: 'invalid_enum' }] });
    const extra = await upload(cookie, { ...vehicleDoc(mine), storage_key: 'x' }, { bytes: PNG, name: 'x.png' });
    expect(extra.body.error.details).toEqual([{ field: 'storage_key', reason: 'not_writable' }]);
    const outside = await upload(cookie, vehicleDoc(theirs), { bytes: PNG, name: 'x.png' });
    expect(outside.status).toBe(400);
    expect(outside.body.error.details).toEqual([{ field: 'owner_id', reason: 'references_missing_record' }]);
  });

  test('needs document:write (a dispatcher has only read); no session is 401', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    expect((await upload(await signIn(['dispatcher'], depot), vehicleDoc(vehicle), { bytes: PNG, name: 'x.png' })).status).toBe(403);
    expect((await upload('', vehicleDoc(vehicle), { bytes: PNG, name: 'x.png' })).status).toBe(401);
  });

  test('publishes DocumentUploaded with the expiry for FMS-26', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const received: DomainEvent[] = [];
    const off = eventBus.subscribe('DocumentUploaded', (e) => void received.push(e));
    try {
      const res = await upload(await signIn(['depot_admin'], depot), vehicleDoc(vehicle, { document_type: 'insurance', expires_on: '2027-01-31' }), { bytes: PDF, name: 'i.pdf' });
      expect(received.map((e) => e.payload)).toEqual([
        { document_id: res.body.data.id, owner_type: 'vehicle', owner_id: vehicle.public_id, document_type: 'insurance', expires_on: '2027-01-31' },
      ]);
    } finally {
      off();
    }
  });
});

describe('GET /documents/{id} and the signed link', () => {
  test('returns metadata and a link that serves the exact bytes with safe headers', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);
    const created = await upload(cookie, vehicleDoc(vehicle), { bytes: PDF, name: 'Ré gistration "2026".pdf' });

    const res = await request(app).get(`/api/v1/documents/${created.body.data.id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.url).toMatch(new RegExp(`^/api/v1/documents/${created.body.data.id}/content\\?expires=\\d+&signature=[0-9a-f]{64}$`));
    const expiresIn = Date.parse(res.body.data.url_expires_at) - Date.now();
    expect(expiresIn).toBeGreaterThan(59 * 60 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(60 * 60 * 1000);

    const file = await getContent(res.body.data.url); // no cookie: the signature is the permission
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-disposition']).toBe(`inline; filename="R_ gistration _2026_.pdf"; filename*=UTF-8''${encodeURIComponent('Ré gistration "2026".pdf')}`);
  });

  test('the signed link stops working after 1 hour; a tampered link never works', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const created = await upload(await signIn(['depot_admin'], depot), vehicleDoc(vehicle), { bytes: PNG, name: 'x.png' });
    const id = created.body.data.id as string;
    const signedAgo = (minutes: number) => new DocumentUrlSigner(config.jwtSecret, () => Date.now() - minutes * 60 * 1000).sign(id).url;

    expect((await getContent(signedAgo(59))).status).toBe(200);
    const expired = await request(app).get(signedAgo(61));
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('AUTH_TOKEN_EXPIRED');

    const fresh = signedAgo(0);
    const tampered = fresh.replace(/signature=(.)/, (_m, c: string) => `signature=${c === 'a' ? 'b' : 'a'}`);
    expect((await request(app).get(tampered)).body.error.code).toBe('AUTH_TOKEN_INVALID');
    const longer = fresh.replace(/expires=(\d+)/, (_m, e: string) => `expires=${Number(e) + 3600}`);
    expect((await request(app).get(longer)).body.error.code).toBe('AUTH_TOKEN_INVALID');
    expect((await request(app).get(`/api/v1/documents/${id}/content`)).body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  test('a document from another depot returns 404', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const theirs = await createVehicle({ depot: b });
    const created = await upload(await signIn(['depot_admin'], b), vehicleDoc(theirs), { bytes: PNG, name: 'x.png' });

    for (const roles of [['dispatcher'], ['depot_admin']] as RoleName[][]) {
      const res = await request(app).get(`/api/v1/documents/${created.body.data.id}`).set('Cookie', await signIn(roles, a));
      expect(res.status, roles[0]).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    expect((await request(app).get(`/api/v1/documents/${randomUUID()}`).set('Cookie', await signIn(['admin']))).status).toBe(404);
    expect((await request(app).get('/api/v1/documents/not-an-id').set('Cookie', await signIn(['admin']))).status).toBe(404);
  });
});

describe('driver documents', () => {
  test("a driver uploads and reads their own licence, but not another driver's", async () => {
    const depot = await createDepot();
    const me = await createDriver({ depot });
    const other = await createDriver({ depot });
    await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [
      me.user.id,
      (await createUser({ password: PASSWORD })).password_hash,
    ]);
    const cookie = await login(me.user.email as string);
    const asOwner = (driver: Record<string, unknown>) => ({ owner_type: 'driver', owner_id: String(driver.public_id), document_type: 'licence' });

    const mine = await upload(cookie, asOwner(me.driver), { bytes: JPEG, name: 'licence.jpg' });
    expect(mine.status).toBe(201);
    expect((await request(app).get(`/api/v1/documents/${mine.body.data.id}`).set('Cookie', cookie)).status).toBe(200);

    const theirsByMe = await upload(cookie, asOwner(other.driver), { bytes: JPEG, name: 'x.jpg' });
    expect(theirsByMe.body.error.details).toEqual([{ field: 'owner_id', reason: 'references_missing_record' }]);
    const theirs = await upload(await signIn(['admin']), asOwner(other.driver), { bytes: JPEG, name: 'x.jpg' });
    expect((await request(app).get(`/api/v1/documents/${theirs.body.data.id}`).set('Cookie', cookie)).status).toBe(404);
  });
});

describe('DELETE /documents/{id}', () => {
  test('soft-deletes with one audit row: the document and its link are gone, the file is kept', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['fleet_manager']);
    const created = await upload(cookie, vehicleDoc(vehicle, { retain_until: '2033-12-31' }), { bytes: PNG, name: 'x.png' });
    const link = (await request(app).get(`/api/v1/documents/${created.body.data.id}`).set('Cookie', cookie)).body.data.url;
    const files = storedFiles().length;

    const res = await request(app).delete(`/api/v1/documents/${created.body.data.id}`).set('Cookie', cookie);
    expect(res.status).toBe(204);
    expect((await auditRows(res)).map((r) => [r.action, r.entity_type])).toEqual([['DELETE', 'document.documents']]);
    expect((await request(app).get(`/api/v1/documents/${created.body.data.id}`).set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).get(link)).status).toBe(404);
    expect(storedFiles().length).toBe(files);
    expect((await request(app).delete(`/api/v1/documents/${created.body.data.id}`).set('Cookie', cookie)).status).toBe(404);
  });

  test('needs document:delete (admin and fleet_manager, who see every depot)', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const created = await upload(await signIn(['admin']), vehicleDoc(vehicle), { bytes: PNG, name: 'x.png' });
    const id = created.body.data.id;
    expect((await request(app).delete(`/api/v1/documents/${id}`).set('Cookie', await signIn(['depot_admin'], depot))).status).toBe(403);
    expect((await request(app).delete(`/api/v1/documents/${id}`).set('Cookie', await signIn(['fleet_manager'], await createDepot()))).status).toBe(204);
  });
});
