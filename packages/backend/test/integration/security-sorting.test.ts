import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { DRIVER_SORT_COLUMNS } from '../../src/modules/fleet/infrastructure/driver.repository';
import { VEHICLE_SORT_COLUMNS } from '../../src/modules/fleet/infrastructure/vehicle.repository';
import { createUser } from '../support/factories';
import { operations, spec } from '../support/openapi';

// FMS-103 (docs/security.md): a list sorts only by what its spec declares. Anything else, a column that exists (password_hash) or
// SQL, is a 400 before it can reach a query. Walks every GET in docs/openapi.yaml that has a sort_by parameter, so a new sortable
// list is covered the day it is documented.

const app = createApp();
const PASSWORD = 'Sorting-Test-1';

interface Param {
  name?: string;
  in?: string;
  $ref?: string;
  schema?: { enum?: string[] };
}
const resolve = (p: Param): Param => (p.$ref ? ((spec.components.parameters as unknown as Record<string, Param>)[p.$ref.split('/').pop()!] ?? p) : p);

const sortable = operations
  .filter((o) => o.method === 'get' && !/[{:]/.test(o.path))
  .map((o) => ({ ...o, sort: [...(o.item.parameters ?? []), ...(o.op.parameters ?? [])].map((p) => resolve(p as Param)).find((p) => p.name === 'sort_by' && p.in === 'query') }))
  .filter((o) => o.sort);

async function adminCookie(): Promise<string> {
  const user = await createUser({ roles: ['admin'], password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const EVIL = [
  'password_hash',
  'passwordHash',
  'id; DROP TABLE auth.users',
  'created_at DESC, (SELECT pg_sleep(5))',
  'created_at--',
  '1',
  'ID',
  '',
  '../../etc/passwd',
];

describe('sortable lists', () => {
  test('there are some, and they are found in the spec', () => {
    expect(sortable.length).toBeGreaterThanOrEqual(6);
    expect(sortable.map((o) => o.path)).toEqual(expect.arrayContaining(['/vehicles', '/drivers', '/routes', '/inventory/parts']));
  });

  for (const { path, sort } of sortable) {
    test(`${path}: sort_by outside its allow-list is 400, whatever it looks like`, async () => {
      const cookie = await adminCookie();
      for (const value of EVIL) {
        const res = await request(app).get(`/api/v1${path}`).query({ sort_by: value }).set('Cookie', cookie);
        expect(res.status, `${path}?sort_by=${value} -> ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(400);
        expect(res.body.error.code).toMatch(/^VALIDATION_/);
        expect(JSON.stringify(res.body)).not.toMatch(/syntax error|pg_sleep|relation .* does not exist/i);
      }
      // Repeated, or an array: not a string the allow-list can compare.
      const twice = await request(app).get(`/api/v1${path}?sort_by=${sort!.schema!.enum![0]}&sort_by=password_hash`).set('Cookie', cookie);
      expect(twice.status).toBe(400);
      const array = await request(app).get(`/api/v1${path}?sort_by[]=password_hash`).set('Cookie', cookie);
      expect(array.status).toBe(400);
    });

    test(`${path}: the direction is asc or desc and nothing else`, async () => {
      const cookie = await adminCookie();
      for (const value of ['sideways', 'asc; DROP TABLE x', 'ASC NULLS FIRST, id']) {
        const res = await request(app).get(`/api/v1${path}`).query({ sort_order: value }).set('Cookie', cookie);
        expect(res.status, `${path}?sort_order=${value}`).toBe(400);
      }
    });

    test(`${path}: every value its spec declares works, so the allow-list and the spec agree`, async () => {
      const cookie = await adminCookie();
      const declared = sort!.schema?.enum ?? [];
      expect(declared.length).toBeGreaterThan(0);
      for (const value of declared) {
        const res = await request(app).get(`/api/v1${path}`).query({ sort_by: value }).set('Cookie', cookie);
        expect(res.status, `${path}?sort_by=${value} -> ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      }
    });

    test(`${path}: a filter nobody declared is never applied: the answer is the unfiltered one, not an error`, async () => {
      const cookie = await adminCookie();
      const plain = await request(app).get(`/api/v1${path}`).set('Cookie', cookie);
      const unknown = await request(app).get(`/api/v1${path}`).query({ password_hash: 'x', 'users.email': 'a', 'id; DROP TABLE x': '1' }).set('Cookie', cookie);
      expect(plain.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(unknown.body.data).toEqual(plain.body.data);
      expect(unknown.body.meta.total ?? unknown.body.meta.pagination?.total).toEqual(plain.body.meta.total ?? plain.body.meta.pagination?.total);
    });
  }
});

describe('the spec and the code agree on what a list can sort by', () => {
  const declared = (path: string, name: string) =>
    [...(sortable.find((o) => o.path === path)?.op.parameters ?? [])].map((p) => resolve(p as Param)).find((p) => p.name === name)?.schema?.enum ?? [];

  test('/vehicles: sort_by and then_by are exactly the columns the query knows', () => {
    expect([...declared('/vehicles', 'sort_by')].sort()).toEqual(Object.keys(VEHICLE_SORT_COLUMNS).sort());
    expect([...declared('/vehicles', 'then_by')].sort()).toEqual(Object.keys(VEHICLE_SORT_COLUMNS).sort());
  });

  test('/drivers: sort_by is exactly the columns the query knows', () => {
    expect([...declared('/drivers', 'sort_by')].sort()).toEqual(Object.keys(DRIVER_SORT_COLUMNS).sort());
  });

  test('/vehicles: then_by is refused outside the list too', async () => {
    const cookie = await adminCookie();
    for (const value of ['password_hash', 'id; DROP TABLE x']) {
      const res = await request(app).get('/api/v1/vehicles').query({ then_by: value }).set('Cookie', cookie);
      expect(res.status, value).toBe(400);
    }
  });
});
