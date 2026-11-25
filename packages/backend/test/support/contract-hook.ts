/**
 * The API contract hook (FMS-100, docs/api-docs.md#contract-tests): every response an integration test receives through
 * supertest is checked against docs/openapi.yaml, with every object closed, so a field the spec does not name fails.
 * Runs as a setup file of the integration project, around every test file.
 *
 * - Each response is matched to its operation by method and path, and its JSON body validated against the schema the
 *   spec gives that operation and status (strictResponseProblems). A status the operation does not list, and a body
 *   that does not match, are both drift.
 * - A test file with drift fails in afterAll, naming each operation, status and the validator's words.
 * - Every operation called is recorded for the coverage report (global-setup.ts prints it after the run).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import supertest from 'supertest';
import { afterAll, expect } from 'vitest';
import { CONTRACT_DIR } from './contract-coverage';
import { operationFor, strictResponseProblems } from './openapi';

interface Seen {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type TestProto = { assert: (err: unknown, res: Seen | undefined, fn: unknown) => unknown; method: string; url: string };
const Test = (supertest as unknown as { Test: { prototype: TestProto } }).Test;

const drift = new Map<string, string>();
const called = new Set<string>();

const original = Test.prototype.assert;
if (!(original as { contractHook?: boolean }).contractHook) {
  const hooked = function (this: TestProto, err: unknown, res: Seen | undefined, fn: unknown) {
    if (res) check(this.method, this.url, res);
    return original.call(this, err, res, fn);
  };
  (hooked as { contractHook?: boolean }).contractHook = true;
  Test.prototype.assert = hooked;
}

function check(method: string, url: string, res: Seen) {
  const op = operationFor(method, url);
  // Not an operation of the spec (a test-only route, a static file): openapi.test.ts compares the mounted routes.
  if (!op) return;
  // A 404 that is not the API's JSON envelope came from something else on that path (the metrics port, a static
  // server): the API's own 404 for an unknown route is JSON.
  if (res.status === 404 && !(res.headers['content-type'] ?? '').includes('json')) return;
  const key = `${op.method.toUpperCase()} ${op.path}`;
  called.add(`${key} ${res.status}`);
  // A file, an image or a redirect has no JSON body to check: only its status is.
  const json = (res.headers['content-type'] ?? '').includes('json') && !Buffer.isBuffer(res.body);
  const problem = strictResponseProblems(op.path, op.method, res.status, json ? res.body : undefined);
  if (problem && !drift.has(`${key} ${res.status}`)) drift.set(`${key} ${res.status}`, problem);
}

afterAll(() => {
  mkdirSync(CONTRACT_DIR, { recursive: true });
  const file = join(CONTRACT_DIR, `${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [...called].map((c) => JSON.stringify({ called: c }));
  for (const [where, problem] of drift) lines.push(JSON.stringify({ drift: where, problem }));
  if (lines.length > 0) appendFileSync(file, lines.join('\n') + '\n');
  if (process.env.CONTRACT_MODE === 'report') return;
  expect(
    [...drift].map(([where, problem]) => `${where}: ${problem}`),
    'A response is not what docs/openapi.yaml says (FMS-100): document the field or status, or stop sending it',
  ).toEqual([]);
});
