import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { UserStatus } from '../domain/auth-policy';

export interface UserCredentials {
  id: string;
  status: UserStatus;
  passwordHash: string;
}

/** Who the caller is and what they may do; becomes `req.user`. */
export interface Principal {
  id: string;
  publicId: string;
  status: UserStatus;
  depotId: string | null;
  roles: string[];
  permissions: string[];
}

/** The `user` object of /auth/me and the login response. Public ids only. */
export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  status: UserStatus;
  depot_id: string | null;
  last_login_at: Date | null;
}

// Roles and permissions come only through active roles.
const PRINCIPAL_SQL = `
  SELECT u.id, u.public_id AS "publicId", u.status, u.depot_id AS "depotId",
         COALESCE(array_agg(DISTINCT r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
         COALESCE(array_agg(DISTINCT p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
    FROM auth.users u
    LEFT JOIN auth.user_roles ur ON ur.user_id = u.id
    LEFT JOIN auth.roles r ON r.id = ur.role_id AND r.is_active
    LEFT JOIN auth.role_permissions rp ON rp.role_id = r.id
    LEFT JOIN auth.permissions p ON p.id = rp.permission_id`;

export class AuthUserRepository {
  /** Emails are unique case-insensitively (ux_auth_users_email_lower). */
  async findCredentialsByEmail(db: Queryable, email: string): Promise<UserCredentials | null> {
    const res = await db.query<UserCredentials>(
      'SELECT id, status, password_hash AS "passwordHash" FROM auth.users WHERE lower(email) = lower($1)',
      [email],
    );
    return res.rows[0] ?? null;
  }

  async findPrincipalById(db: Queryable, id: string): Promise<Principal | null> {
    const res = await db.query<Principal>(`${PRINCIPAL_SQL} WHERE u.id = $1 GROUP BY u.id`, [id]);
    return res.rows[0] ?? null;
  }

  async findPrincipalByPublicId(db: Queryable, publicId: string): Promise<Principal | null> {
    const res = await db.query<Principal>(`${PRINCIPAL_SQL} WHERE u.public_id = $1 GROUP BY u.id`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findProfile(db: Queryable, id: string): Promise<UserProfile | null> {
    const res = await db.query<UserProfile>(
      `SELECT u.public_id AS id, u.email, u.full_name, u.phone, u.status,
              d.public_id AS depot_id, u.last_login_at
         FROM auth.users u
         LEFT JOIN fleet.depots d ON d.id = u.depot_id
        WHERE u.id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async recordLogin(db: Queryable, id: string): Promise<void> {
    await db.query('UPDATE auth.users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  }
}
