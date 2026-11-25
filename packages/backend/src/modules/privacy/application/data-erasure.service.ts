import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../../shared/errors/app-error';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { withTransaction } from '../../../shared/infrastructure/transaction';
import type { RequestUser } from '../../../types/express';

/** One kind of personal data a module holds for erasure, and how to erase a driver's (internal id) on a transaction. */
export interface Eraser {
  kind: string;
  erase(client: PoolClient, ctx: MutationContext, driverId: string): Promise<number>;
}

export interface DataErasureDeps {
  db: Pool;
  drivers: { byPublicId(db: Queryable, publicId: string): Promise<{ id: string; publicId: string } | null> };
  erasers: readonly Eraser[];
}

/**
 * A driver's erasure (FMS-104, FMS-158, docs/driver-data-protection.md): every kind of personal data the modules
 * register for erasure is deleted for good, in one transaction, and the erasure is audited with its counts and reason.
 * What is not registered (trips, fuel logs, inspections: fleet records with their own retention) stays.
 */
export class DataErasureService {
  constructor(private readonly deps: DataErasureDeps) {}

  async erase(user: RequestUser, correlationId: string, driverPublicId: string, reason: string): Promise<{ driver_id: string; erased: Record<string, number> }> {
    const { db, drivers, erasers } = this.deps;
    return withTransaction(db, async (client) => {
      const driver = await drivers.byPublicId(client, driverPublicId);
      if (!driver) throw new AppError(404, 'NOT_FOUND', 'Driver not found.');
      const ctx: MutationContext = { userId: user.id, correlationId };
      const erased: Record<string, number> = {};
      for (const e of erasers) erased[e.kind] = await e.erase(client, ctx, driver.id);
      await recordAuditEntry(client, {
        action: 'privacy.data_erased',
        userId: user.id,
        entityType: 'fleet.drivers',
        entityId: driver.id,
        correlationId,
        details: { driver_id: driver.publicId, reason, erased },
      });
      return { driver_id: driver.publicId, erased };
    });
  }
}
