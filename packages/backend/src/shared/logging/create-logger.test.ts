import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger } from './create-logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { logger: createLogger('info', stream), lines };
}

test('logs one JSON object per line with level, time and service', () => {
  const { logger, lines } = capture();
  logger.info({ requestId: 'r1' }, 'hello');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'hello');
  assert.equal(lines[0].service, 'fms-backend');
  assert.equal(lines[0].requestId, 'r1');
  assert.ok(typeof lines[0].time === 'string');
});

test('credentials, tokens and cookies are redacted', () => {
  const { logger, lines } = capture();
  logger.info({
    password: 'p1',
    user: { email: 'a@b.c', password_hash: 'h', token: 't' },
    req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: 'json' } },
    body: { refreshToken: 'r', jwtSecret: 's' },
  });
  const out = JSON.stringify(lines[0]);
  for (const secret of ['p1', '"h"', '"t"', 'Bearer abc', 'sid=1', '"r"', '"s"']) assert.ok(!out.includes(secret), `leaked ${secret}`);
  assert.ok(out.includes('a@b.c') && out.includes('json'), 'non-secret fields are kept');
});

test('respects the level', () => {
  const lines: unknown[] = [];
  const logger = createLogger('warn', new Writable({ write(c, _e, cb) { lines.push(c); cb(); } }));
  logger.info('hidden');
  logger.warn('shown');
  assert.equal(lines.length, 1);
});
