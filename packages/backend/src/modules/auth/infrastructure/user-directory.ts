import type { PoolClient } from 'pg';
import { auditedMutation, type MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { UserStatus } from '../domain/auth-policy';

/** What other modules may know about a user account. Internal ids for joins; `publicId` for responses. */
export interface UserAccount {
  id: string;
  publicId: string;
  fullName: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  /** Home depot (internal fleet.depots id), or null. */
  depotId: string | null;
  roles: string[];
}

const ACCOUNT_SQL = `
  SELECT u.id, u.public_id AS "publicId", u.full_name AS "fullName", u.email, u.phone, u.status,
         u.depot_id AS "depotId",
         COALESCE(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
    FROM auth.users u
    LEFT JOIN auth.user_roles ur ON ur.user_id = u.id
    LEFT JOIN auth.roles r ON r.id = ur.role_id AND r.is_active`;

/**
 * User accounts for other modules (CONVENTIONS.md, Modules rule 4: they may
 * not query auth.users themselves). The fleet module uses it for drivers,
 * whose name, contact details and home depot live on their account.
 */
export const userDirectory = {
  async findByPublicId(db: Queryable, publicId: string): Promise<UserAccount | null> {
    const res = await db.query<UserAccount>(`${ACCOUNT_SQL} WHERE u.public_id = $1 GROUP BY u.id`, [publicId]);
    return res.rows[0] ?? null;
  },

  /** Emails are unique case-insensitively (ux_auth_users_email_lower). */
  async findByEmail(db: Queryable, email: string): Promise<UserAccount | null> {
    const res = await db.query<UserAccount>(`${ACCOUNT_SQL} WHERE lower(u.email) = lower($1) GROUP BY u.id`, [email]);
    return res.rows[0] ?? null;
  },

  async findByIds(db: Queryable, ids: readonly string[]): Promise<UserAccount[]> {
    if (ids.length === 0) return [];
    const res = await db.query<UserAccount>(`${ACCOUNT_SQL} WHERE u.id = ANY($1::bigint[]) GROUP BY u.id`, [ids]);
    return res.rows;
  },

  /** Moves a user to a home depot, as one audited change in the caller's transaction. */
  async setDepot(client: PoolClient, ctx: MutationContext, userId: string, depotId: string): Promise<void> {
    await auditedMutation(client, ctx, 'auth.users', 'UPDATE', userId, { depot_id: depotId });
  },
};
