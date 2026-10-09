import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { UserAccount } from '../../auth';

type AccountFields = Pick<UserAccount, 'id' | 'fullName' | 'email' | 'depotId' | 'status'>;

/**
 * fleet.driver_accounts: the account fields drivers are listed by (migration
 * 017), copied from the auth module's user accounts so the driver list can
 * filter, search and sort in one fleet query. Derived data: not audited.
 */
export const driverAccounts = {
  /** Inserts or refreshes the copies of these accounts. */
  async upsert(db: Queryable, accounts: readonly AccountFields[]): Promise<void> {
    if (accounts.length === 0) return;
    await db.query(
      `INSERT INTO fleet.driver_accounts (user_id, full_name, email, depot_id, account_status, synced_at)
       SELECT a.user_id, a.full_name, a.email, a.depot_id, a.account_status, CURRENT_TIMESTAMP
         FROM unnest($1::bigint[], $2::text[], $3::text[], $4::bigint[], $5::shared.user_status[])
           AS a(user_id, full_name, email, depot_id, account_status)
       ON CONFLICT (user_id) DO UPDATE
          SET full_name = EXCLUDED.full_name, email = EXCLUDED.email, depot_id = EXCLUDED.depot_id,
              account_status = EXCLUDED.account_status, synced_at = EXCLUDED.synced_at`,
      [
        accounts.map((a) => a.id),
        accounts.map((a) => a.fullName),
        accounts.map((a) => a.email),
        accounts.map((a) => a.depotId),
        accounts.map((a) => a.status),
      ],
    );
  },

  /** User ids of every driver, for the daily re-sync. */
  async driverUserIds(db: Queryable): Promise<string[]> {
    const res = await db.query<{ user_id: string }>('SELECT user_id FROM fleet.drivers ORDER BY user_id');
    return res.rows.map((r) => r.user_id);
  },

  /** Whether the user is a driver (has a fleet.drivers row). */
  async isDriver(db: Queryable, userId: string): Promise<boolean> {
    const res = await db.query('SELECT 1 FROM fleet.drivers WHERE user_id = $1', [userId]);
    return res.rowCount === 1;
  },
};
