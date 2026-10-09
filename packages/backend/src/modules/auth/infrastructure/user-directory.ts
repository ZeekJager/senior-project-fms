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

/** `%term%` for ILIKE, with `%`, `_` and `\` matched literally. */
const containsPattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

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

  async findByIds(db: Queryable, ids: readonly string[]): Promise<UserAccount[]> {
    if (ids.length === 0) return [];
    const res = await db.query<UserAccount>(`${ACCOUNT_SQL} WHERE u.id = ANY($1::bigint[]) GROUP BY u.id`, [ids]);
    return res.rows;
  },

  /**
   * Ids of the users in any of `depotIds` (null: any depot) whose name or
   * email contains `search` (if given). Lets a module filter its own rows by
   * user attributes in SQL, with `user_id = ANY($ids)`, and still page there.
   */
  async idsMatching(db: Queryable, filter: { depotIds: readonly string[] | null; search?: string }): Promise<string[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.depotIds !== null) {
      params.push(filter.depotIds);
      where.push(`u.depot_id = ANY($${params.length}::bigint[])`);
    }
    if (filter.search) {
      params.push(containsPattern(filter.search));
      where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    const res = await db.query<{ id: string }>(
      `SELECT u.id FROM auth.users u${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
    );
    return res.rows.map((r) => r.id);
  },

  /** Moves a user to a home depot, as one audited change in the caller's transaction. */
  async setDepot(client: PoolClient, ctx: MutationContext, userId: string, depotId: string): Promise<void> {
    await auditedMutation(client, ctx, 'auth.users', 'UPDATE', userId, { depot_id: depotId });
  },
};
