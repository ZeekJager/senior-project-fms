import type { PoolClient } from 'pg';

export type MutationAction = 'INSERT' | 'UPDATE' | 'DELETE';
export type Row = Record<string, unknown>;
/** BIGINT ids arrive from node-pg as strings. */
export type RecordId = string | number;

export interface MutationContext {
  userId: RecordId | null;
  correlationId: string;
}

// Table and column names are spliced into SQL (they cannot be bound as
// parameters), so only plain schema-qualified identifiers are accepted.
// Callers pass literals like 'fleet.vehicles'; request-body keys must never
// reach SQL unchecked.
const TABLE_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const COLUMN_RE = /^[a-z_][a-z0-9_]*$/;

function assertTable(tableName: string): void {
  if (!TABLE_RE.test(tableName)) {
    throw new Error(`Invalid table name '${tableName}': use schema.table, e.g. 'fleet.vehicles'`);
  }
}

function assertColumns(keys: string[]): void {
  for (const k of keys) {
    if (!COLUMN_RE.test(k)) throw new Error(`Invalid column name '${k}'`);
  }
}

// Soft delete (DoD #6): every core table has is_active, except auth.users,
// whose is_active is generated from status and cannot be written directly.
function softDeleteSql(tableName: string): string {
  return tableName === 'auth.users'
    ? `UPDATE ${tableName} SET status = 'inactive' WHERE id = $1`
    : `UPDATE ${tableName} SET is_active = FALSE WHERE id = $1`;
}

// Never copied into audit.audit_logs: the audit trail is readable through
// GET /audit-logs, and a hash is enough for an offline guessing attack.
const REDACTED_COLUMNS = new Set(['password_hash', 'token_hash']);

function forAudit(row: Row): string {
  const copy: Row = { ...row };
  for (const col of REDACTED_COLUMNS) if (col in copy) copy[col] = '[REDACTED]';
  return JSON.stringify(copy);
}

async function selectById(client: PoolClient, tableName: string, id: RecordId): Promise<Row | undefined> {
  const res = await client.query<Row>(`SELECT * FROM ${tableName} WHERE id = $1`, [id]);
  return res.rows[0];
}

/**
 * Performs one mutation and writes its audit.audit_logs row on the given
 * client, so both commit or roll back together with the caller's
 * transaction. DELETE is a soft delete.
 */
export async function auditedMutation(
  client: PoolClient,
  ctx: MutationContext,
  tableName: string,
  action: MutationAction,
  recordId: RecordId | null = null,
  data: Row = {},
): Promise<Row> {
  assertTable(tableName);
  assertColumns(Object.keys(data));

  let oldState: Row | null = null;
  let newState: Row | undefined;
  let finalRecordId: RecordId | null = recordId;

  if (action !== 'INSERT') {
    if (recordId === null) throw new Error(`${action} on ${tableName} requires a record id`);
    const existing = await selectById(client, tableName, recordId);
    if (!existing) throw new Error(`Record ${recordId} not found in ${tableName}`);
    oldState = existing;
  }

  switch (action) {
    case 'DELETE': {
      await client.query(softDeleteSql(tableName), [recordId]);
      newState = await selectById(client, tableName, recordId as RecordId);
      break;
    }
    case 'UPDATE': {
      const keys = Object.keys(data);
      const setString = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      await client.query(`UPDATE ${tableName} SET ${setString} WHERE id = $1`, [recordId, ...Object.values(data)]);
      newState = await selectById(client, tableName, recordId as RecordId);
      break;
    }
    case 'INSERT': {
      const keys = Object.keys(data);
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query<Row>(
        `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        Object.values(data),
      );
      newState = res.rows[0];
      finalRecordId = newState?.id as RecordId;
      break;
    }
    default:
      throw new Error(`Unknown mutation action '${String(action)}'`);
  }

  if (!newState) throw new Error(`${action} on ${tableName} returned no row`);

  await client.query(
    `INSERT INTO audit.audit_logs
       (entity_type, entity_id, action, old_values, new_values, user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tableName,
      finalRecordId,
      action,
      oldState ? forAudit(oldState) : null,
      forAudit(newState),
      ctx.userId,
      ctx.correlationId,
    ],
  );

  return newState;
}
