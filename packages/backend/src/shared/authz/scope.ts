import type { RequestUser } from '../../types/express';

/**
 * Which rows a caller may see. Permissions say what a user may do; scope says
 * to which records. Every repository that returns depot-owned or
 * driver-owned rows builds its WHERE clause from a scope, so the filter lives
 * in the query and a forgotten check in a controller cannot leak data.
 *
 * - `all`: no filter.
 * - `depot`: only rows of that depot.
 * - `own`: only rows belonging to that user (a driver's own trips, location).
 * - `none`: nothing. The default for anyone who cannot be placed, so a
 *   mistake in the data fails closed.
 */
export type Scope =
  | { kind: 'all' }
  | { kind: 'depot'; depotId: string }
  | { kind: 'own'; userId: string }
  | { kind: 'none' };

/**
 * Roles that see every depot. The admin bypasses depot scope but never
 * permissions: `authorize` still has to pass. Every other role is limited to
 * its home depot, and a depot-scoped user with no depot sees nothing.
 */
export const DEPOT_UNSCOPED_ROLES: readonly string[] = ['admin', 'fleet_manager', 'fleet_owner', 'compliance_officer'];

export function depotScope(user: RequestUser | undefined): Scope {
  if (!user || user.id === null) return { kind: 'none' };
  if (user.roles.some((role) => DEPOT_UNSCOPED_ROLES.includes(role))) return { kind: 'all' };
  return user.depotId === null ? { kind: 'none' } : { kind: 'depot', depotId: user.depotId };
}

/**
 * A driver sees only their own records. Anyone who also holds another role
 * (a dispatcher, a depot admin) is limited by `depotScope` instead.
 */
export function ownDriverScope(user: RequestUser | undefined): Scope {
  if (!user || user.id === null) return { kind: 'none' };
  const driverOnly = user.roles.length > 0 && user.roles.every((role) => role === 'driver');
  return driverOnly ? { kind: 'own', userId: user.id } : { kind: 'all' };
}

const COLUMN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

export interface ScopeClause {
  /** A SQL condition to AND into a WHERE clause: `TRUE`, `FALSE` or `col = $n`. */
  sql: string;
  /** The values for the placeholder, empty when there is none. */
  params: string[];
}

/**
 * The SQL condition for a scope. `column` is a literal from repository code
 * (never request input) and `nextParam` is the number of the next free `$n`.
 *
 *     const { sql, params } = scopeClause(depotScope(req.user), 'v.depot_id', 2);
 *     db.query(`SELECT ... FROM fleet.vehicles v WHERE v.id = $1 AND ${sql}`, [id, ...params]);
 *
 * A row outside the scope simply is not returned, so the service answers 404,
 * not 403, and the caller cannot tell a forbidden record from a missing one.
 */
export function scopeClause(scope: Scope, column: string, nextParam: number): ScopeClause {
  if (!COLUMN.test(column)) throw new Error(`Invalid column '${column}'`);
  switch (scope.kind) {
    case 'all':
      return { sql: 'TRUE', params: [] };
    case 'depot':
      return { sql: `${column} = $${nextParam}`, params: [scope.depotId] };
    case 'own':
      return { sql: `${column} = $${nextParam}`, params: [scope.userId] };
    case 'none':
      return { sql: 'FALSE', params: [] };
  }
}

/**
 * Whether a record in `depotId` is inside a scope, for the rare check that
 * cannot be a WHERE clause because the depot lives in another module (a
 * driver's depot is on their user account). Prefer `scopeClause`.
 */
export function depotInScope(scope: Scope, depotId: string | null): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'depot') return depotId === scope.depotId;
  return false;
}
