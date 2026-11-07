import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A user's own account, for their data export (FMS-104): what the system holds about them, never the password hash or tokens. */
export interface AccountExport {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  status: string;
  roles: string[];
  last_login_at: string | null;
  created_at: string;
}

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function accountExport(db: Queryable, userId: string): Promise<AccountExport | null> {
  const res = await db.query<AccountExport>(
    `SELECT u.public_id AS id, u.email, u.full_name, u.phone, u.status::text AS status,
            COALESCE((SELECT array_agg(r.name ORDER BY r.name) FROM auth.user_roles ur JOIN auth.roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS roles,
            ${iso('u.last_login_at')} AS last_login_at, ${iso('u.created_at')} AS created_at
       FROM auth.users u WHERE u.id = $1`,
    [userId],
  );
  return res.rows[0] ?? null;
}
