/**
 * The API under load (FMS-61): the compiled server (`dist/src/server.js`, what the production image runs) in its own
 * process with NODE_ENV=production, on the load database, with Redis, the outbox relay and the Socket.IO gateway as in
 * production. Its log goes to a file beside the report; its metrics port stays on the loopback.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';

const BACKEND = path.resolve(__dirname, '../..');
export const SERVER_ENTRY = path.join(BACKEND, 'dist', 'src', 'server.js');

export interface RunningServer {
  api: string;
  origin: string;
  metricsUrl: string;
  stop(): Promise<void>;
}

/**
 * Every client of the load runs on this one machine, so they share one address. The per-address limits (sign-in,
 * the address ceiling) would count them all as one person: they are raised for the run. The per-session and
 * per-device limits stay as in production.
 */
export const LOAD_LIMITS = {
  RATE_LIMIT_IP_CEILING_PER_MINUTE: '1000000',
  RATE_LIMIT_AUTH_PER_MINUTE: '10000',
  RATE_LIMIT_ANONYMOUS_PER_MINUTE: '100000',
};

/**
 * What the API is not given: the schema owner's credentials (the runner needs them to create the database; the API
 * connects as the app role, as in production) and the backup role's. Without either, backups are off
 * (docs/backups.md): a scheduled pg_dump firing mid-scenario would measure the dump, not the load.
 */
export const WITHHELD = ['DB_ADMIN_USER', 'DB_ADMIN_PASSWORD', 'BACKUP_DB_USER', 'BACKUP_DB_PASSWORD'];

export function serverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of WITHHELD) delete out[name];
  return out;
}

async function waitReady(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The API exited with ${child.exitCode} while starting (see its log).`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The API was not ready within ${timeoutMs / 1000} s (${url}).`);
}

export async function startServer(opts: { port: number; metricsPort: number; logFile: string }): Promise<RunningServer> {
  if (!existsSync(SERVER_ENTRY)) throw new Error(`${SERVER_ENTRY} is missing: build the backend first (npm run build -w fms-backend).`);
  const log = createWriteStream(opts.logFile);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: BACKEND,
    env: {
      ...serverEnv(process.env),
      ...LOAD_LIMITS,
      NODE_ENV: 'production',
      PORT: String(opts.port),
      METRICS_PORT: String(opts.metricsPort),
      METRICS_HOST: '127.0.0.1',
      TRUST_PROXY: '0',
      LOG_LEVEL: process.env.LOAD_SERVER_LOG_LEVEL ?? 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  const origin = `http://127.0.0.1:${opts.port}`;
  try {
    await waitReady(`${origin}/health/ready`, child, 60_000);
  } catch (err) {
    child.kill();
    throw err;
  }
  return {
    api: `${origin}/api/v1`,
    origin,
    metricsUrl: `http://127.0.0.1:${opts.metricsPort}/metrics`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const force = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.once('exit', () => {
          clearTimeout(force);
          log.end(() => resolve());
        });
        child.kill('SIGTERM');
      }),
  };
}
