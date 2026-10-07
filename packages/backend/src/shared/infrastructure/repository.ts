import type { Pool, PoolClient } from 'pg';
import { auditedMutation, type MutationAction, type MutationContext, type RecordId, type Row } from './audited-mutation';
import { withTransaction } from './transaction';

/**
 * Base class for module repositories (`infrastructure/*.repository.impl.ts`).
 * Every write goes through `mutate`, which records the audit row in the same
 * transaction. Pass `client` to join a transaction opened by `transaction`.
 */
export abstract class Repository {
  protected constructor(protected readonly db: Pool) {}

  protected transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.db, fn);
  }

  protected mutate(
    ctx: MutationContext,
    tableName: string,
    action: MutationAction,
    recordId: RecordId | null = null,
    data: Row = {},
    client?: PoolClient,
  ): Promise<Row> {
    if (client) return auditedMutation(client, ctx, tableName, action, recordId, data);
    return this.transaction((c) => auditedMutation(c, ctx, tableName, action, recordId, data));
  }
}
