import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { dumpError } from '../domain/backup';

/** A database to dump or restore into, with credentials that may read (or create) every table in it. */
export interface DbTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** pg_dump and pg_restore (FMS-144), behind an interface so a test can watch them fail. */
export interface PgTools {
  /** Dumps the database in pg_dump's custom format, compressed, into `file`. Rejects with pg_dump's own words. */
  dump(target: DbTarget, file: string): Promise<void>;
  /** Restores `file` into the target database, stopping at the first error. */
  restore(target: DbTarget, file: string): Promise<void>;
}

export interface PgToolsOptions {
  /** Where pg_dump and pg_restore are; unset, they are found on PATH. */
  binDir?: string | null;
  /**
   * Development and tests only: run the tools inside this PostgreSQL container (`docker exec`) instead,
   * for a machine without the PostgreSQL client. The container reaches its own server on localhost:5432.
   */
  container?: string | null;
}

/** The most stderr kept from a tool, for its error message. */
const MAX_STDERR = 64 * 1024;

export function pgClientTools(options: PgToolsOptions = {}): PgTools {
  const command = (tool: 'pg_dump' | 'pg_restore', target: DbTarget, args: string[]): { cmd: string; args: string[] } => {
    const where = options.container
      ? ['--host', 'localhost', '--port', '5432']
      : ['--host', target.host, '--port', String(target.port)];
    const full = [...where, '--username', target.user, '--no-password', '--dbname', target.database, ...args];
    if (options.container) {
      // `-e PGPASSWORD` with no value passes the variable from docker's own environment: never on a command line.
      return { cmd: 'docker', args: ['exec', '-i', '-e', 'PGPASSWORD', options.container, tool, ...full] };
    }
    return { cmd: options.binDir ? path.join(options.binDir, tool) : tool, args: full };
  };

  /** Runs a tool with `stdin` piped in or `stdout` piped out, and its password in its environment only. */
  const run = (tool: 'pg_dump' | 'pg_restore', target: DbTarget, args: string[], io: { stdin?: string; stdout?: string }) =>
    new Promise<void>((resolve, reject) => {
      const { cmd, args: argv } = command(tool, target, args);
      const child = spawn(cmd, argv, {
        env: { ...process.env, PGPASSWORD: target.password },
        stdio: [io.stdin ? 'pipe' : 'ignore', io.stdout ? 'pipe' : 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk;
      });
      const streams: Promise<void>[] = [];
      if (io.stdout) streams.push(pipeline(child.stdout!, createWriteStream(io.stdout, { flags: 'wx', mode: 0o600 })));
      if (io.stdin) streams.push(pipeline(createReadStream(io.stdin), child.stdin!));
      let spawnError: Error | null = null;
      child.once('error', (err: NodeJS.ErrnoException) => {
        spawnError = err.code === 'ENOENT' ? new Error(`${cmd} was not found: install the PostgreSQL client tools, or set BACKUP_PG_BIN_DIR.`) : err;
      });
      child.once('close', (code) => {
        Promise.allSettled(streams).then((settled) => {
          if (spawnError) return reject(spawnError);
          if (code !== 0) return reject(new Error(dumpError(stderr, `${tool} exited with code ${code}`)));
          const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
          if (failed) return reject(failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason)));
          resolve();
        }, reject);
      });
    });

  return {
    dump: (target, file) => run('pg_dump', target, ['--format=custom', '--compress=6'], { stdout: file }),
    restore: (target, file) => run('pg_restore', target, ['--exit-on-error'], { stdin: file }),
  };
}
