/**
 * The load testing suite (FMS-61, docs/load-testing.md). Builds a seeded database of its own, starts the compiled API
 * as in production, runs the scenarios against it, writes a JSON report and a page beside it (the same name, .html),
 * and exits 1 if any budget is missed.
 *
 *   npm run load-test -w fms-backend                              # the card's workload (about 10 minutes)
 *   npm run load-test -w fms-backend -- --profile smoke           # the same, briefly (pull requests)
 *   npm run load-test -w fms-backend -- --only gps,dashboard --report /tmp/load.json
 *
 * Needs PostgreSQL and Redis as the integration tests do; never production, never a database not named *_test.
 */
// First: refuses production and points this process at the load database, before anything below loads the config.
import { LOAD_DB_NAME } from './env';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pool } from '../../src/db';
import { closeRedis } from '../../src/shared/cache';
import { createUsers, datasetSize, fuelVehicles, outboxBacklog, prepareDatabase, registerDevices, seedBudget } from './fixtures';
import { ServerSampler, type ServerLoad } from './metrics';
import { BUDGETS, PROFILES, type Profile } from './profiles';
import { renderHtml, type LoadReport } from './html';
import { checksFor, formatChecks, type Results } from './report';
import { runApi } from './scenarios/api';
import { runDashboard } from './scenarios/dashboard';
import { runGps } from './scenarios/gps';
import { startServer, LOAD_LIMITS } from './server';
import { Session } from './session';

const SCENARIOS = ['gps', 'api', 'dashboard'] as const;
type Scenario = (typeof SCENARIOS)[number];

function options() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', default: 'full' },
      only: { type: 'string' },
      report: { type: 'string' },
      port: { type: 'string', default: '3901' },
      'metrics-port': { type: 'string', default: '9901' },
      // Development: keep the database the last run seeded, skipping the 3-minute seed. Never in CI.
      'reuse-db': { type: 'boolean', default: false },
    },
  });
  if (!(values.profile! in PROFILES)) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(', ')}.`);
  const only = values.only ? values.only.split(',').map((s) => s.trim()) : [...SCENARIOS];
  for (const s of only) if (!SCENARIOS.includes(s as Scenario)) throw new Error(`--only takes ${SCENARIOS.join(', ')}; got "${s}".`);
  const profile = PROFILES[values.profile as Profile['name']];
  const report = values.report ?? path.resolve(__dirname, '../../load-report', `${profile.name}.json`);
  return { profile, only: only as Scenario[], report, port: Number(values.port), metricsPort: Number(values['metrics-port']), reuseDb: values['reuse-db']! };
}

function commit(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Signs in `emails`, a few at a time: sign-in hashes the password, which is meant to be slow, so a burst is no workload. */
async function signIn(api: string, emails: string[], password: string): Promise<Session[]> {
  const sessions: Session[] = [];
  for (let i = 0; i < emails.length; i += 5) sessions.push(...(await Promise.all(emails.slice(i, i + 5).map((e) => Session.signIn(api, e, password)))));
  return sessions;
}

async function drainOutbox(log: (line: string) => void): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let backlog = await outboxBacklog();
  if (backlog > 0) log(`Waiting for the API to deliver the seed's ${backlog} queued events...`);
  while (backlog > 0) {
    if (Date.now() > deadline) throw new Error(`${backlog} events were still queued after 10 minutes: the outbox relay is not keeping up.`);
    await new Promise((r) => setTimeout(r, 2000));
    backlog = await outboxBacklog();
  }
}

async function measured<T>(metricsUrl: string, work: () => Promise<T>): Promise<T & { server: ServerLoad }> {
  const sampler = new ServerSampler(metricsUrl);
  await sampler.start();
  const result = await work();
  return { ...result, server: await sampler.stop() };
}

async function main(): Promise<void> {
  const opts = options();
  const { profile } = opts;
  const startedAt = new Date();
  const reportDir = path.dirname(opts.report);
  mkdirSync(reportDir, { recursive: true });
  const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

  log(`Load suite (FMS-61), profile ${profile.name}: ${opts.only.join(', ')}. Database ${LOAD_DB_NAME}${opts.reuseDb ? ', as the last run left it' : ', recreated'}.`);
  if (!opts.reuseDb) {
    await prepareDatabase(LOAD_DB_NAME);
    log('Seeding the budget dataset (200 vehicles, 300 drivers, 1,000 trips)...');
    await seedBudget();
  }
  const dataset = await datasetSize();
  const userCount = Math.max(profile.api.users, profile.dashboard.users, profile.gps.observers);
  const users = await createUsers(userCount);
  const devices = opts.only.includes('gps') ? await registerDevices(profile.gps.vehicles) : [];
  const vehicles = opts.only.includes('api') ? await fuelVehicles(profile.api.users) : [];
  log(`Dataset: ${JSON.stringify(dataset)}. ${userCount} users, ${devices.length} devices.`);

  const server = await startServer({ port: opts.port, metricsPort: opts.metricsPort, logFile: path.join(reportDir, `${profile.name}-server.log`) });
  log(`API up at ${server.api} (NODE_ENV=production).`);
  // The seed leaves its events in the outbox. A position waiting behind them more than 30 s is dropped by design
  // (docs/realtime.md), which would count as a drop the load did not cause: measure only once they are delivered.
  await drainOutbox(log);
  const results: Results = {};
  try {
    if (opts.only.includes('gps')) {
      const w = profile.gps;
      log(`Scenario 1, GPS: ${w.vehicles} vehicles every ${w.intervalS} s for ${w.durationS} s, ${w.observers} dashboards watching...`);
      const observers = await signIn(server.api, users.emails.slice(0, w.observers), users.password);
      results.gps = await measured(server.metricsUrl, () => runGps(server.origin, server.api, devices, observers, w));
    }
    if (opts.only.includes('api')) {
      const w = profile.api;
      log(`Scenario 2, API: ${w.users} users for ${w.durationS} s...`);
      const sessions = await signIn(server.api, users.emails.slice(0, w.users), users.password);
      results.api = await measured(server.metricsUrl, () => runApi(sessions, vehicles, w));
    }
    if (opts.only.includes('dashboard')) {
      const w = profile.dashboard;
      log(`Scenario 3, dashboards: ${w.users} users for ${w.durationS} s...`);
      const sessions = await signIn(server.api, users.emails.slice(0, w.users), users.password);
      results.dashboard = await measured(server.metricsUrl, () => runDashboard(sessions, w));
    }
  } finally {
    await server.stop();
  }

  const checks = checksFor(results);
  const passed = checks.every((c) => c.passed);
  const report: LoadReport & { budgets: typeof BUDGETS } = {
    card: 'FMS-61',
    profile: profile.name,
    passed,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    commit: commit(),
    machine: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30) },
    server: { nodeEnv: 'production', raisedLimits: LOAD_LIMITS },
    dataset,
    budgets: BUDGETS,
    checks,
    results,
  };
  writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  const page = opts.report.replace(/(\.json)?$/i, '.html');
  writeFileSync(page, renderHtml(report));
  console.log(`\n${formatChecks(checks)}\n`);
  log(`${passed ? 'All budgets met' : 'Budgets missed'}. Report: ${opts.report} (page: ${page})`);
  process.exitCode = passed ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    await closeRedis().catch(() => undefined);
  });
