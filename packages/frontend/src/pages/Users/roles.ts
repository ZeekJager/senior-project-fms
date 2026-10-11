import type { BadgeTone } from '@/components/ui'
import type { Role, UserStatus } from './api'

export const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  fleet_manager: 'Fleet manager',
  fleet_owner: 'Fleet owner',
  compliance_officer: 'Compliance officer',
  depot_admin: 'Depot admin',
  dispatcher: 'Dispatcher',
  technician: 'Technician',
  finance_clerk: 'Finance clerk',
  driver: 'Driver',
}

export const roleLabel = (name: string) => ROLE_LABELS[name] ?? name.replace(/_/g, ' ')

/** Roles whose holders see one depot only: the API requires a home depot for them. */
export const DEPOT_SCOPED_ROLES = ['dispatcher', 'driver', 'technician', 'depot_admin', 'finance_clerk']

export const needsDepot = (roles: readonly string[]) => roles.some((r) => DEPOT_SCOPED_ROLES.includes(r))

export const STATUS_LABELS: Record<UserStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  suspended: { label: 'Suspended', tone: 'warning' },
  locked: { label: 'Locked', tone: 'danger' },
  inactive: { label: 'Deactivated', tone: 'neutral' },
}

/**
 * The API's escalation rule, mirrored so the form can disable what the
 * server would refuse: admin only by an admin, and no role carrying a
 * permission the caller lacks. The server still decides.
 */
export function mayAssignRole(caller: { roles: readonly string[]; permissions: readonly string[] }, role: Role): boolean {
  if (role.name === 'admin' && !caller.roles.includes('admin')) return false
  return role.permissions.every((p) => caller.permissions.includes(p))
}

/** Permission codes grouped by resource (`vehicle:read` → vehicle: read), for the roles overview. */
export function groupPermissions(codes: readonly string[]): [string, string[]][] {
  const groups = new Map<string, string[]>()
  for (const code of codes) {
    const [resource, action = ''] = code.split(':')
    groups.set(resource, [...(groups.get(resource) ?? []), action])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
}
