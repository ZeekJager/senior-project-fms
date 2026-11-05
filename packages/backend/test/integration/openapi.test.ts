import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { routeRegistry } from '../../src/shared/authz/route-policy';
import { ERROR_CODES } from '../../src/shared/errors/app-error';
import { METHODS, documentedShapes, drift, operations, raw, schemaProblems, shape, spec } from '../support/openapi';

// docs/openapi.yaml is the contract (api-contract §24, FMS-65, FMS-119). These checks keep it true, both ways:
// every route the API mounts is described and every operation it describes is mounted, so a new undocumented
// route fails CI; its structure is sound; and every error code it names is one the API can send. That its
// responses match the real ones is checked in contract.test.ts.

const app = createApp();
const mounted = () => routeRegistry(app).map((r) => shape(r.method, r.path));

describe('docs/openapi.yaml: the routes', () => {
  test('every route the API mounts is described: a new undocumented one fails (add it to docs/openapi.yaml)', () => {
    expect(drift(mounted(), documentedShapes).undocumented, 'Mounted but not in docs/openapi.yaml; describe each one there').toEqual([]);
  });

  test('every operation it describes is mounted: one for a route that is gone, or misspelt, fails', () => {
    expect(drift(mounted(), documentedShapes).unmounted, 'In docs/openapi.yaml but not mounted; remove it or fix its path or method').toEqual([]);
  });

  test('the check itself: it names an undocumented route and an operation with no route, and treats :tripId and {trip_id} alike', () => {
    expect(drift(['GET /trips', 'POST /trips', 'GET /trips/{}'], ['GET /trips', 'GET /trips/{}', 'DELETE /trips/{}'])).toEqual({
      undocumented: ['POST /trips'],
      unmounted: ['DELETE /trips/{}'],
    });
    expect(shape('get', '/api/v1/trips/:tripId/assign')).toBe('GET /trips/{}/assign');
    expect(shape('POST', '/trips/{trip_id}/assign')).toBe('POST /trips/{}/assign');
    expect(shape('GET', '/health/live')).toBe('GET /health/live');
  });
});

describe('docs/openapi.yaml: its structure (spec lint)', () => {
  test('is OpenAPI 3.1, served under /api/v1', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe('/api/v1');
    expect(operations.length).toBeGreaterThan(0);
  });

  test('every operation has a unique operation id, a summary and a declared tag', () => {
    const declared = new Set(spec.tags.map((t) => t.name));
    const ids = operations.map((o) => o.op.operationId);
    expect(operations.filter((o) => !o.op.operationId).map((o) => shape(o.method, o.path))).toEqual([]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(operations.filter((o) => !o.op.summary).map((o) => shape(o.method, o.path))).toEqual([]);
    expect(operations.filter((o) => !o.op.tags?.length || o.op.tags.some((t) => !declared.has(t))).map((o) => shape(o.method, o.path))).toEqual([]);
  });

  test('every operation answers with a success and, unless it is public, lists 401 for a missing session', () => {
    const noSuccess = operations.filter((o) => !Object.keys(o.op.responses ?? {}).some((s) => s.startsWith('2')));
    expect(noSuccess.map((o) => shape(o.method, o.path))).toEqual([]);
    const isPublic = (o: (typeof operations)[number]) => Array.isArray(o.op.security) && o.op.security.length === 0;
    const withoutSession = operations.filter((o) => !isPublic(o) && !o.op.security && !o.op.responses?.['401']);
    expect(withoutSession.map((o) => shape(o.method, o.path))).toEqual([]);
  });

  test('every {path parameter} of a path is declared, and none is declared that the path does not have', () => {
    const named = (list: { $ref?: string; name?: string; in?: string }[] = []) =>
      list.map((p) => (p.$ref ? spec.components.parameters[p.$ref.split('/').pop()!] : p)).filter((p) => p.in === 'path').map((p) => p.name!);
    for (const { path, method, item, op } of operations) {
      const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
      const declared = [...named(item.parameters), ...named(op.parameters)].sort();
      expect(declared, `${method.toUpperCase()} ${path}`).toEqual(inPath);
    }
  });

  test('every $ref points at a component that exists', () => {
    const refs = [...raw.matchAll(/\$ref: '#\/([^']+)'/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const target = ref.split('/').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], spec);
      expect(target, ref).toBeDefined();
    }
  });

  test('every schema is valid JSON Schema (it compiles)', () => {
    expect(schemaProblems()).toEqual([]);
  });

  test('only the five methods the API uses are described', () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      const keys = Object.keys(item).filter((k) => !['servers', 'parameters', 'summary', 'description', '$ref'].includes(k));
      expect(keys.filter((k) => !(METHODS as readonly string[]).includes(k)), path).toEqual([]);
    }
  });

  test('every error code it names is one the API sends (api-contract §3.6)', () => {
    const named = new Set([...raw.matchAll(/\b(?:AUTH|FORBIDDEN|VALIDATION|CONFLICT|NOT|RATE|INTERNAL|UPSTREAM|UNSUPPORTED|PAYLOAD)_[A-Z_]+\b/g)].map((m) => m[0]));
    expect(named.size).toBeGreaterThan(0);
    expect([...named].filter((code) => !(ERROR_CODES as readonly string[]).includes(code))).toEqual([]);
  });
});
