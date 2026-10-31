import type { PoolClient } from 'pg';
import { DEPOT_UNSCOPED_ROLES } from '../../../shared/authz/scope';
import { auditedMutation, type MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { UserStatus } from '../domain/auth-policy';
import { UNSET_HASH } from './password-hasher';

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

  /**
   * A new account with the driver role in a home depot, created without a
   * password (it cannot sign in until one is set). One audited insert in the
   * caller's transaction. The email must be free (the caller checks first;
   * the unique index is the backstop).
   */
  async createDriverAccount(
    client: PoolClient,
    ctx: MutationContext,
    account: { email: string; fullName: string; phone: string | null; depotId: string },
  ): Promise<UserAccount> {
    const row = await auditedMutation(client, ctx, 'auth.users', 'INSERT', null, {
      email: account.email,
      password_hash: UNSET_HASH,
      full_name: account.fullName,
      phone: account.phone,
      depot_id: account.depotId,
    });
    await client.query(
      `INSERT INTO auth.user_roles (user_id, role_id, assigned_by)
       SELECT $1, id, $2 FROM auth.roles WHERE name = 'driver'`,
      [row.id, ctx.userId],
    );
    const [created] = await userDirectory.findByIds(client, [row.id as string]);
    return created;
  },

  /**
   * Internal ids of active accounts holding any of `roles` who see the depot (internal id): its own staff,
   * and anyone whose roles see every depot. With no depot, only the latter. For an alert's recipients (FMS-92).
   */
  async activeWithRoles(db: Queryable, roles: readonly string[], depotId: string | null, unscopedRoles: readonly string[]): Promise<string[]> {
    if (roles.length === 0) return [];
    const res = await db.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM auth.users u
         JOIN auth.user_roles ur ON ur.user_id = u.id
         JOIN auth.roles r ON r.id = ur.role_id AND r.is_active
        WHERE u.status = 'active' AND r.name = ANY($1::text[])
          AND ((u.depot_id IS NOT NULL AND u.depot_id = $2::bigint)
               OR EXISTS (SELECT 1 FROM auth.user_roles ur2 JOIN auth.roles r2 ON r2.id = ur2.role_id AND r2.is_active
                           WHERE ur2.user_id = u.id AND r2.name = ANY($3::text[])))
        ORDER BY u.id`,
      [roles, depotId, unscopedRoles],
    );
    return res.rows.map((r) => r.id);
  },

  /**
   * An active account that holds `permission` through an active role, by public id, with its home depot (internal
   * id) and whether its roles see every depot (DEPOT_UNSCOPED_ROLES). For choosing who handles an incident (FMS-89).
   */
  async activeHolder(db: Queryable, publicId: string, permission: string): Promise<{ id: string; depotId: string | null; unscoped: boolean } | null> {
    const res = await db.query<{ id: string; depotId: string | null; unscoped: boolean }>(
      `SELECT u.id, u.depot_id AS "depotId", bool_or(r.name = ANY($3::text[])) AS unscoped
         FROM auth.users u
         JOIN auth.user_roles ur ON ur.user_id = u.id
         JOIN auth.roles r ON r.id = ur.role_id AND r.is_active
        WHERE u.public_id = $1 AND u.status = 'active'
        GROUP BY u.id
       HAVING bool_or(EXISTS (SELECT 1 FROM auth.role_permissions rp JOIN auth.permissions p ON p.id = rp.permission_id
                               WHERE rp.role_id = r.id AND p.code = $2))`,
      [publicId, permission, DEPOT_UNSCOPED_ROLES],
    );
    return res.rows[0] ?? null;
  },

  /** Active accounts whose home depot this is (internal id); a depot with any cannot be deleted. */
  async countActiveInDepot(db: Queryable, depotId: string): Promise<number> {
    const res = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth.users WHERE depot_id = $1 AND status = 'active'`,
      [depotId],
    );
    return res.rows[0].n;
  },

  /** Moves a user to a home depot, as one audited change in the caller's transaction. */
  async setDepot(client: PoolClient, ctx: MutationContext, userId: string, depotId: string): Promise<void> {
    await auditedMutation(client, ctx, 'auth.users', 'UPDATE', userId, { depot_id: depotId });
  },
};
