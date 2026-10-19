import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../../src/app';
import { ERROR_CODES } from '../../src/shared/errors/app-error';
import { createUser } from '../support/factories';

// docs/openapi.yaml lists endpoints as their cards are built (FMS-31, FMS-76
// first). These checks keep it honest: every operation it lists is mounted,
// and every error code it names is one the API can send.

const SPEC_PATH = join(__dirname, '..', '..', '..', '..', 'docs', 'openapi.yaml');
const raw = readFileSync(SPEC_PATH, 'utf8');
const spec = parse(raw) as { openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, { operationId?: string }>> };
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const PASSWORD = 'Openapi-Test-1';
const app = createApp();

const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({ path, method, operationId: item[method]!.operationId })),
);

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

  test('every error code it names is one the API sends (api-contract §3.6)', () => {
    const named = new Set([...raw.matchAll(/\b(?:AUTH|FORBIDDEN|VALIDATION|CONFLICT|NOT|RATE|INTERNAL|UPSTREAM|UNSUPPORTED|PAYLOAD)_[A-Z_]+\b/g)].map((m) => m[0]));
    expect(named.size).toBeGreaterThan(0);
    expect([...named].filter((code) => !(ERROR_CODES as readonly string[]).includes(code))).toEqual([]);
  });
});
