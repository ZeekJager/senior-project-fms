import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../../src/app';
import { mountedRoutes } from '../../src/shared/authz/route-policy';
import { ERROR_CODES } from '../../src/shared/errors/app-error';
import { createUser } from '../support/factories';
import { ALIASES, NOT_YET_DOCUMENTED, OUTSIDE_API_BASE } from '../support/openapi-baseline';

// docs/openapi.yaml lists endpoints as their cards are built (FMS-31, FMS-76
// first). These checks keep it honest, both ways: every operation it lists is
// mounted, every route the API mounts is listed (a new undocumented one fails,
// FMS-119), and every error code it names is one the API can send.

const SPEC_PATH = join(__dirname, '..', '..', '..', '..', 'docs', 'openapi.yaml');
const raw = readFileSync(SPEC_PATH, 'utf8');
const spec = parse(raw) as { openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, { operationId?: string }>> };
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const PASSWORD = 'Openapi-Test-1';
const app = createApp();

const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({ path, method, operationId: item[method]!.operationId })),
);

/** `GET /trips/{}`: a method and a path under /api/v1, every parameter (`:tripId` or `{trip_id}`) as `{}`. */
const shape = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/^\/api\/v1(?=\/)/, '').replace(/(:[A-Za-z]\w*|\{[^}]*\})/g, '{}')}`;

/** What the check reports: routes nobody described, and baseline lines that no longer belong. */
function drift(mounted: string[], documented: Set<string>, baseline: string[]) {
  const known = new Set(baseline);
  return {
    undocumented: [...new Set(mounted)].filter((route) => !documented.has(route) && !known.has(route)).sort(),
    stale: [...known].filter((route) => !mounted.includes(route) || documented.has(route)).sort(),
  };
}

const documented = new Set(operations.map((o) => shape(o.method, o.path)));
const baseline = [...OUTSIDE_API_BASE, ...ALIASES, ...NOT_YET_DOCUMENTED];

describe('docs/openapi.yaml', () => {
  test('is OpenAPI 3.1 with unique operation ids, served under /api/v1', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe('/api/v1');
    expect(operations.length).toBeGreaterThan(0);
    const ids = operations.map((o) => o.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every $ref points at a component that exists', () => {
    const doc = parse(raw) as Record<string, unknown>;
    const refs = [...raw.matchAll(/\$ref: '#\/([^']+)'/g)].map((m) => m[1]);
    for (const ref of refs) {
      const target = ref.split('/').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc);
      expect(target, ref).toBeDefined();
    }
  });

  test('every operation it lists is mounted (an unknown route says "No route for")', async () => {
    const admin = await createUser({ roles: ['admin'], password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email: admin.email, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    for (const { path, method } of operations) {
      const url = `/api/v1${path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000')}`;
      const res = await request(app)[method](url).set('Cookie', cookie).send({});
      expect(res.body.error?.message ?? '', `${method.toUpperCase()} ${path}`).not.toMatch(/^No route for/);
    }
  });

  test('every route the API mounts is described: a new undocumented one fails (add it to docs/openapi.yaml)', () => {
    const { undocumented } = drift(mountedRoutes(app).map((r) => shape(r.method, r.path)), documented, baseline);
    expect(undocumented, 'Mounted but not in docs/openapi.yaml; describe each one there').toEqual([]);
  });

  test('the grandfathered list holds only routes still mounted and still undocumented (delete a line when its operation is described)', () => {
    const { stale } = drift(mountedRoutes(app).map((r) => shape(r.method, r.path)), documented, baseline);
    expect(stale, 'In test/support/openapi-baseline.ts but removed or now described; delete these lines').toEqual([]);
  });

  test('the check itself: it names an undocumented route, and a baseline line gone stale', () => {
    const spec = new Set(['GET /trips', 'GET /trips/{}']);
    const mounted = ['GET /trips', 'GET /trips/{}', 'POST /trips', 'GET /legacy'];
    expect(drift(mounted, spec, ['GET /legacy'])).toEqual({ undocumented: ['POST /trips'], stale: [] });
    expect(drift(mounted, spec, ['GET /legacy', 'POST /trips', 'GET /trips', 'DELETE /gone'])).toEqual({
      undocumented: [],
      stale: ['DELETE /gone', 'GET /trips'], // gone from the API, and now described in the spec
    });
    expect(shape('get', '/api/v1/trips/:tripId/assign')).toBe('GET /trips/{}/assign');
    expect(shape('POST', '/trips/{trip_id}/assign')).toBe('POST /trips/{}/assign');
    expect(shape('GET', '/health/live')).toBe('GET /health/live');
  });

  test('every error code it names is one the API sends (api-contract §3.6)', () => {
    const named = new Set([...raw.matchAll(/\b(?:AUTH|FORBIDDEN|VALIDATION|CONFLICT|NOT|RATE|INTERNAL|UPSTREAM|UNSUPPORTED|PAYLOAD)_[A-Z_]+\b/g)].map((m) => m[0]));
    expect(named.size).toBeGreaterThan(0);
    expect([...named].filter((code) => !(ERROR_CODES as readonly string[]).includes(code))).toEqual([]);
  });
});
