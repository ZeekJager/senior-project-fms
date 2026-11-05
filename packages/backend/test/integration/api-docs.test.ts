import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../../src/app';
import { routeRegistry } from '../../src/shared/authz/route-policy';
import { apiDocsEnabledFor, findSpec } from '../../src/shared/http/api-docs';
import { SPEC_PATH } from '../support/openapi';

// FMS-65: Swagger UI on the committed spec, served at /api-docs outside production.

describe('the API documentation page', () => {
  const app = createApp({ apiDocs: true });

  test('/api-docs is the Swagger UI page, loading the committed spec and its own files', async () => {
    const page = await request(app).get('/api-docs');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/html/);
    expect(page.text).toContain('swagger-ui-bundle.js');
    expect(page.text).toContain('/api-docs/swagger-ui.css');

    for (const [file, type] of [
      ['/api-docs/swagger-ui-bundle.js', /javascript/],
      ['/api-docs/swagger-ui.css', /css/],
      ['/api-docs/init.js', /javascript/],
    ] as const) {
      const res = await request(app).get(file);
      expect([file, res.status]).toEqual([file, 200]);
      expect(res.headers['content-type']).toMatch(type);
    }
    expect((await request(app).get('/api-docs/init.js')).text).toContain('/api-docs/openapi.yaml');
  });

  test('/api-docs/openapi.yaml is docs/openapi.yaml itself, not a copy, and it parses', async () => {
    const res = await request(app).get('/api-docs/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
    expect(res.text).toBe(readFileSync(SPEC_PATH, 'utf8'));
    expect((parse(res.text) as { openapi: string }).openapi).toBe('3.1.0');
    expect(findSpec()).toBe(SPEC_PATH);
  });

  test('it reads and nothing else: a POST finds no route', async () => {
    const res = await request(app).post('/api-docs').send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('it is not an API route: the route check lists nothing under /api-docs', () => {
    expect(routeRegistry(app).filter((r) => r.path.startsWith('/api-docs'))).toEqual([]);
  });
});

describe('where it is served', () => {
  test('not when switched off, and not in production', async () => {
    const off = createApp({ apiDocs: false });
    expect((await request(off).get('/api-docs')).status).toBe(404);
    expect((await request(off).get('/api-docs/openapi.yaml')).status).toBe(404);

    expect(apiDocsEnabledFor('production')).toBe(false);
    expect(apiDocsEnabledFor('development')).toBe(true);
    expect(apiDocsEnabledFor('test')).toBe(true);
  });

  test('by default it follows the environment: on in tests', async () => {
    expect((await request(createApp()).get('/api-docs')).status).toBe(200);
  });
});
