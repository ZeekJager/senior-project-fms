import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';

// FMS-112 (docs/release.md): the release check refuses a placeholder secret and never prints one.

const SCRIPT = path.resolve(__dirname, '../../../scripts/deploy/release-check.sh');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(env: Record<string, string>, args: string[] = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fms-release-check-'));
  dirs.push(dir);
  const file = path.join(dir, 'prod.env');
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  chmodSync(file, 0o600);
  // No stack, no git checkout and no domain here: those checks fail, the configuration checks are what is tested.
  const res = spawnSync('sh', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, COMPOSE_FILE: 'missing.yml' }, timeout: 60_000 });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const LONG = 'x'.repeat(40);

test('a placeholder, short or missing secret fails; a set one passes and is never printed', () => {
  const { code, out } = run({
    DB_ADMIN_PASSWORD: LONG,
    DB_APP_PASSWORD: 'change-me',
    REDIS_PASSWORD: 'short',
    JWT_SECRET: `"${LONG}"`,
    DATA_ENCRYPTION_KEY: LONG,
    CSP_MODE: 'report-only',
  });
  expect(code).toBe(1);
  expect(out).toContain('PASS  DB_ADMIN_PASSWORD is set (40 characters)');
  expect(out).toContain('PASS  JWT_SECRET is set (40 characters)');
  expect(out).toContain('FAIL  DB_APP_PASSWORD is still a placeholder');
  expect(out).toContain('FAIL  REDIS_PASSWORD is only 5 characters');
  expect(out).toContain('FAIL  ML_SERVICE_TOKEN is not set');
  expect(out).toContain('WARN  CSP_MODE is report-only');
  expect(out).toContain('FAIL  FMS_DOMAIN is not set');
  expect(out).toContain('Release checks: FAILED');
  expect(out).not.toContain(LONG);
  expect(out).not.toContain('change-me');
});

test('an unknown option is refused', () => {
  expect(run({}, ['--force']).code).toBe(2);
});
