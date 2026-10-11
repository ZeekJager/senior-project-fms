import type { PoolClient } from 'pg';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import { auditedMutation, type MutationContext, type Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { UserStatus } from '../domain/auth-policy';
import { hasUsablePassword } from './password-hasher';

/** auth.users with its active roles (internal ids). */
export interface AdminUserRow {
  id: string;
  publicId: string;
  email: string;
  fullName: string;
  phone: string | null;
  depotId: string | null;
  status: UserStatus;
  roles: string[];
  hasPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
}

export interface UserListFilter extends Page {
  search?: string;
  role?: string;
  status?: UserStatus;
  depotId?: string;
}

const USER_SQL = `
  SELECT u.id, u.public_id AS "publicId", u.email, u.full_name AS "fullName", u.phone, u.depot_id AS "depotId",
         u.status, u.password_hash AS "passwordHash", u.last_login_at AS "lastLoginAt",
         u.created_at AS "createdAt", u.updated_at AS "updatedAt",
         COALESCE(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
    FROM auth.users u
    LEFT JOIN auth.user_roles ur ON ur.user_id = u.id
    LEFT JOIN auth.roles r ON r.id = ur.role_id AND r.is_active`;

type RawUser = Omit<AdminUserRow, 'hasPassword'> & { passwordHash: string };

/** The hash never leaves this file: only whether a usable one is set. */
function toRow({ passwordHash, ...rest }: RawUser): AdminUserRow {
  return { ...rest, hasPassword: hasUsablePassword(passwordHash) };
}

const containsPattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * User administration over auth.users, auth.user_roles, auth.refresh_sessions
 * and auth.password_tokens (FMS-78). Account writes are audited through
 * auditedMutation (password_hash and token_hash are redacted there); role
 * changes, whose rows have no id of their own, write one audit entry each
 * with the roles before and after.
 */
export class UserAdminRepository {
  async list(db: Queryable, f: UserListFilter): Promise<{ rows: AdminUserRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (f.search) {
      const p = add(containsPattern(f.search));
      where.push(`(u.full_name ILIKE ${p} OR u.email ILIKE ${p})`);
    }
    if (f.status) where.push(`u.status = ${add(f.status)}`);
    if (f.depotId) where.push(`u.depot_id = ${add(f.depotId)}`);
    if (f.role) {
      where.push(`EXISTS (SELECT 1 FROM auth.user_roles ur2 JOIN auth.roles r2 ON r2.id = ur2.role_id WHERE ur2.user_id = u.id AND r2.name = ${add(f.role)})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM auth.users u ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const res = await db.query<RawUser>(`${USER_SQL} ${whereSql} GROUP BY u.id ORDER BY u.full_name, u.id LIMIT ${add(limit)} OFFSET ${add(offset)}`, params);
    return { rows: res.rows.map(toRow), total: count.rows[0].total };
  }

  async findByPublicId(db: Queryable, publicId: string): Promise<AdminUserRow | null> {
    const res = await db.query<RawUser>(`${USER_SQL} WHERE u.public_id = $1 GROUP BY u.id`, [publicId]);
    return res.rows[0] ? toRow(res.rows[0]) : null;
  }

  async findById(db: Queryable, id: string): Promise<AdminUserRow> {
    const res = await db.query<RawUser>(`${USER_SQL} WHERE u.id = $1 GROUP BY u.id`, [id]);
    return toRow(res.rows[0]);
  }

  /** Row-locks the account for a change in the same transaction. */
  async lock(client: PoolClient, publicId: string): Promise<AdminUserRow | null> {
    const id = await client.query<{ id: string }>('SELECT id FROM auth.users WHERE public_id = $1 FOR UPDATE', [publicId]);
    return id.rows[0] ? this.findById(client, id.rows[0].id) : null;
  }

  async emailTaken(db: Queryable, email: string, exceptId?: string): Promise<boolean> {
    const res = await db.query('SELECT 1 FROM auth.users WHERE lower(email) = lower($1) AND id IS DISTINCT FROM $2::bigint', [email, exceptId ?? null]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Active roles with their permission codes. */
  async roles(db: Queryable): Promise<RoleRow[]> {
    const res = await db.query<RoleRow>(
      `SELECT r.id, r.name, r.description,
              COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
         FROM auth.roles r
         LEFT JOIN auth.role_permissions rp ON rp.role_id = r.id
         LEFT JOIN auth.permissions p ON p.id = rp.permission_id
        WHERE r.is_active
        GROUP BY r.id
        ORDER BY r.name`,
    );
    return res.rows;
  }

  /** Active accounts holding the admin role, other than `exceptId`. Locks them, so two demotions cannot both pass. */
  async otherActiveAdmins(client: PoolClient, exceptId: string): Promise<number> {
    const res = await client.query(
      `SELECT u.id FROM auth.users u
         JOIN auth.user_roles ur ON ur.user_id = u.id
         JOIN auth.roles r ON r.id = ur.role_id AND r.is_active AND r.name = 'admin'
        WHERE u.status = 'active' AND u.id <> $1
          FOR UPDATE OF u`,
      [exceptId],
    );
    return res.rowCount ?? 0;
  }

  insertUser(ctx: MutationContext, client: PoolClient, data: { email: string; full_name: string; phone: string | null; depot_id: string | null; password_hash: string }): Promise<Row> {
    return auditedMutation(client, ctx, 'auth.users', 'INSERT', null, { ...data });
  }

  updateUser(ctx: MutationContext, client: PoolClient, id: string, data: Record<string, unknown>): Promise<Row> {
    return auditedMutation(client, ctx, 'auth.users', 'UPDATE', id, data);
  }

  /** Replaces the user's roles with `roleIds`; one audit entry with the role names before and after. */
  async setRoles(ctx: MutationContext, client: PoolClient, userId: string, roleIds: readonly string[], before: readonly string[], after: readonly string[]): Promise<void> {
    await client.query('DELETE FROM auth.user_roles WHERE user_id = $1 AND NOT (role_id = ANY($2::bigint[]))', [userId, roleIds]);
    await client.query(
      `INSERT INTO auth.user_roles (user_id, role_id, assigned_by)
       SELECT $1, unnest($2::bigint[]), $3
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, roleIds, ctx.userId],
    );
    await recordAuditEntry(client, {
      action: 'ROLE_CHANGE',
      userId: ctx.userId,
      entityType: 'auth.user_roles',
      entityId: userId,
      correlationId: ctx.correlationId,
      oldValues: { roles: [...before].sort() },
      newValues: { roles: [...after].sort() },
    });
  }

  /** Ends every session of the user: no refresh will succeed, and access tokens fail their session check. */
  async revokeAllSessions(db: Queryable, userId: string): Promise<number> {
    const res = await db.query('UPDATE auth.refresh_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    return res.rowCount ?? 0;
  }

  /** Closes the user's open tokens, then records a new one (its hash). */
  async issueToken(ctx: MutationContext, client: PoolClient, t: { userId: string; purpose: 'setup' | 'reset'; tokenHash: string; ttlSeconds: number }): Promise<Date> {
    await client.query('UPDATE auth.password_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL', [t.userId]);
    const row = await auditedMutation(client, ctx, 'auth.password_tokens', 'INSERT', null, {
      user_id: t.userId,
      purpose: t.purpose,
      token_hash: t.tokenHash,
      expires_at: new Date(Date.now() + t.ttlSeconds * 1000).toISOString(),
      created_by: ctx.userId,
    });
    return row.expires_at as Date;
  }

  /** An open, unexpired token by hash, row-locked so it can be used once. */
  async lockOpenToken(client: PoolClient, tokenHash: string): Promise<{ id: string; userId: string; purpose: 'setup' | 'reset' } | null> {
    const res = await client.query(
      `SELECT id, user_id AS "userId", purpose FROM auth.password_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
          FOR UPDATE`,
      [tokenHash],
    );
    return res.rows[0] ?? null;
  }

  async useToken(client: PoolClient, id: string): Promise<void> {
    await client.query('UPDATE auth.password_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  }
}
