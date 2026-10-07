import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db';
import { auditedMutation, type MutationAction, type RecordId, type Row } from '../shared/infrastructure/audited-mutation';
import { withTransaction } from '../shared/infrastructure/transaction';

export type DbMutate = (
  tableName: string,
  action: MutationAction,
  recordId?: RecordId | null,
  data?: Row,
) => Promise<Row>;

/**
 * Injects `req.dbMutate`: one audited mutation in its own transaction, with
 * the request's user and correlation id. `tableName` is schema-qualified
 * ('fleet.depots') and is stored as the audit entry's entity_type.
 */
export function auditLogMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.dbMutate = (tableName, action, recordId = null, data = {}) =>
    withTransaction(pool, (client) =>
      auditedMutation(
        client,
        { userId: req.user?.id ?? null, correlationId: req.correlationId },
        tableName,
        action,
        recordId,
        data,
      ),
    );
  next();
}
