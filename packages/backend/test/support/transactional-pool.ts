/**
 * Runs each test inside one database transaction that is rolled back
 * afterwards, so tests leave no rows behind (audit rows included: a
 * rollback is not an UPDATE or DELETE).
 *
 * The app's pool is redirected to a single connection holding that
 * transaction:
 *  - `pool.connect()` returns a wrapper around it whose release() is a no-op;
 *  - the app's BEGIN / COMMIT / ROLLBACK become SAVEPOINT / RELEASE /
 *    ROLLBACK TO SAVEPOINT, so transactional code behaves as in production;
 *  - a statement outside an app transaction runs in its own savepoint, so a
 *    failing statement does not abort the test's transaction.
 *
 * Limits: one connection per test, so
 *  - queries must not run in parallel inside a test (no Promise.all over
 *    database calls): their savepoints would interleave;
 *  - code that needs two concurrent connections, or data committed and
 *    visible to another connection, cannot be tested this way.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';

type QueryArg = string | { text: string; values?: unknown[] };

export function installTransactionalPool(pool: Pool) {
  const originalConnect = pool.connect.bind(pool);
  let client: PoolClient | null = null;
  let savepoints: string[] = [];
  let counter = 0;

  const empty = (command: string) => ({ command, rowCount: 0, rows: [], fields: [], oid: 0 }) as unknown as QueryResult;

  function active(): PoolClient {
    if (!client) {
      throw new Error('Database used outside a test. Put database setup in beforeEach or the test itself, not beforeAll.');
    }
    return client;
  }

  async function query(arg: QueryArg, values?: unknown[]): Promise<QueryResult> {
    const c = active();
    const text = (typeof arg === 'string' ? arg : arg.text).trim().replace(/;$/, '').toUpperCase();

    if (text === 'BEGIN') {
      const name = `app_tx_${++counter}`;
      savepoints.push(name);
      await c.query(`SAVEPOINT ${name}`);
      return empty('BEGIN');
    }
    if (text === 'COMMIT') {
      const name = savepoints.pop();
      if (name) await c.query(`RELEASE SAVEPOINT ${name}`);
      return empty('COMMIT');
    }
    if (text === 'ROLLBACK') {
      const name = savepoints.pop();
      if (name) {
        await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await c.query(`RELEASE SAVEPOINT ${name}`);
      }
      return empty('ROLLBACK');
    }
    // Inside an app transaction: the app's own ROLLBACK handles errors.
    if (savepoints.length) return c.query(arg as string, values);

    // Autocommit statement: isolate it so an error leaves the test transaction usable.
    const name = `stmt_${++counter}`;
    await c.query(`SAVEPOINT ${name}`);
    try {
      const result = await c.query(arg as string, values);
      await c.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw err;
    }
  }

  const wrapper = { query, release: () => {} } as unknown as PoolClient;
  const patched = pool as unknown as { connect: () => Promise<PoolClient>; query: typeof query };
  patched.connect = async () => {
    active();
    return wrapper;
  };
  patched.query = query;

  return {
    async begin(): Promise<void> {
      client = await originalConnect();
      savepoints = [];
      await client.query('BEGIN');
    },
    async rollback(): Promise<void> {
      if (!client) return;
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
        client = null;
        savepoints = [];
      }
    },
  };
}
