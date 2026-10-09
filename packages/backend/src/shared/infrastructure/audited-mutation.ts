import type { PoolClient } from 'pg';
import { recordAuditEntry } from './audit-log';

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
// `data` adds columns to set in the same statement (a vehicle's status
// becomes 'retired'), so the retirement is one change and one audit row.
// document.documents is the one table with deleted_at / deleted_by instead
// (a retirement is subject to its retention date); pass deleted_by in `data`.
function softDeleteSql(tableName: string, extraKeys: string[]): string {
  const extra = extraKeys.map((k, i) => `, ${k} = $${i + 2}`).join('');
  if (tableName === 'auth.users') return `UPDATE ${tableName} SET status = 'inactive'${extra} WHERE id = $1`;
  if (tableName === 'document.documents') return `UPDATE ${tableName} SET deleted_at = CURRENT_TIMESTAMP${extra} WHERE id = $1`;
  return `UPDATE ${tableName} SET is_active = FALSE${extra} WHERE id = $1`;
}

// Never copied into audit.audit_logs, which is readable through GET
// /audit-logs: a hash is enough for an offline guessing attack, and a
// document's storage key is never shown to anyone (api-contract §8).
const REDACTED_COLUMNS = new Set(['password_hash', 'token_hash', 'storage_key']);

function forAudit(row: Row): Row {
  const copy: Row = { ...row };
  for (const col of REDACTED_COLUMNS) if (col in copy) copy[col] = '[REDACTED]';
  return copy;
}

async function selectById(client: PoolClient, tableName: string, id: RecordId): Promise<Row | undefined> {
  const res = await client.query<Row>(`SELECT * FROM ${tableName} WHERE id = $1`, [id]);
  return res.rows[0];
}

/**
 * Performs one mutation and writes its audit.audit_logs row on the given
 * client, so both commit or roll back together with the caller's
 * transaction. DELETE is a soft delete; its `data` is set in the same
 * statement.
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
      await client.query(softDeleteSql(tableName, Object.keys(data)), [recordId, ...Object.values(data)]);
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

  await recordAuditEntry(client, {
    action,
    userId: ctx.userId,
    entityType: tableName,
    entityId: finalRecordId,
    correlationId: ctx.correlationId,
    oldValues: oldState ? forAudit(oldState) : null,
    newValues: forAudit(newState),
  });

  return newState;
}
