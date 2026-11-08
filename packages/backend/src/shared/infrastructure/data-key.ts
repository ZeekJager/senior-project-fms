import type { Pool, PoolClient } from 'pg';

/** The custom setting the database functions read the key from (privacy.data_key(), migration 063). */
export const DATA_KEY_SETTING = 'fms.data_key';

/**
 * Gives a connection the key personal data is encrypted with (FMS-104, docs/driver-data-protection.md), for the
 * session. The database never stores it: the triggers and `privacy.decrypt_text` read it from the setting, and
 * refuse (error 55000) on a connection that has none.
 */
export function setDataKey(client: Pick<PoolClient, 'query'>, key: string): Promise<unknown> {
  return client.query('SELECT set_config($1, $2, false)', [DATA_KEY_SETTING, key]);
}

/**
 * Every new connection of the pool gets the key first. A pool queues the connection's own queries in order, so the
 * key is set before the first query of whoever takes the connection.
 */
export function useDataKey(pool: Pool, key: string, onError: (err: unknown) => void): void {
  pool.on('connect', (client) => {
    setDataKey(client, key).catch(onError);
  });
}
