import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { healthRouter, type OptionalDependency, type ReadinessCheck } from './health';

interface ReadyBody {
  status: string;
  checks: Record<string, string>;
}

const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

async function serve(checks: Record<string, ReadinessCheck>, timeoutMs?: number, optional?: Record<string, OptionalDependency>): Promise<string> {
  const app = express().use(healthRouter(checks, timeoutMs, optional));
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('live is 200 without checking dependencies', async () => {
  const base = await serve({ database: () => Promise.reject(new Error('down')) });
  const res = await fetch(`${base}/health/live`);
  assert.equal(res.status, 200);
});

test('ready is 200 when every check passes', async () => {
  const base = await serve({ database: async () => 'ok', redis: async () => 'ok' });
  const res = await fetch(`${base}/health/ready`);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as ReadyBody).checks, { database: 'ok', redis: 'ok' });
});

test('ready is 503 and names the failing dependency', async () => {
  const base = await serve({ database: () => Promise.reject(new Error('down')), redis: async () => 'ok' });
  const res = await fetch(`${base}/health/ready`);
  assert.equal(res.status, 503);
  const body = (await res.json()) as ReadyBody;
  assert.equal(body.status, 'unavailable');
  assert.deepEqual(body.checks, { database: 'failed', redis: 'ok' });
});

test('a hanging check fails after the timeout instead of hanging the probe', async () => {
  const base = await serve({ database: () => new Promise(() => {}) }, 100);
  const started = Date.now();
  const res = await fetch(`${base}/health/ready`);
  assert.equal(res.status, 503);
  assert.ok(Date.now() - started < 2000);
});

/** A cache-like dependency whose ping uses `this`, as RedisCache's does. */
class FakeRedis implements OptionalDependency {
  constructor(private readonly up: boolean | 'disabled') {}
  state() {
    return this.up === 'disabled' ? ('disabled' as const) : this.up ? ('ok' as const) : ('degraded' as const);
  }
  async ping() {
    if (!this.up) throw new Error('redis down');
  }
}

test('an optional dependency (Redis) that is down is reported as degraded, and ready stays 200', async () => {
  const base = await serve({ database: async () => 'ok' }, undefined, { redis: new FakeRedis(false) });
  const res = await fetch(`${base}/health/ready`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json().then((b) => ({ status: (b as ReadyBody).status, checks: (b as ReadyBody).checks })), {
    status: 'degraded',
    checks: { database: 'ok', redis: 'degraded' },
  });
});

test('an optional dependency that is up is ok; one not configured is disabled', async () => {
  for (const [dep, expected] of [
    [new FakeRedis(true), 'ok'],
    [new FakeRedis('disabled'), 'disabled'],
  ] as const) {
    const res = await fetch(`${await serve({ database: async () => 'ok' }, undefined, { redis: dep })}/health/ready`);
    const body = (await res.json()) as ReadyBody;
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.checks.redis, expected);
  }
});

test('the database down is still 503 whatever Redis says', async () => {
  const base = await serve({ database: () => Promise.reject(new Error('down')) }, undefined, { redis: new FakeRedis(true) });
  assert.equal((await fetch(`${base}/health/ready`)).status, 503);
});
