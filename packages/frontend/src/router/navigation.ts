import { permits } from '@/lib/permissions'
import { portals, type AppRoute, type Portal } from './routes'

/** What navigation needs from the session (/auth/me). */
export interface Viewer {
  roles: readonly string[]
  permissions: readonly string[]
}

/**
 * Read permissions only staff hold. A user who executes trips (drives) and
 * holds none of them works in the driver portal: the mobile layout, and only
 * the driver's own screens. Decided by permission, not role name, like
 * everything else here; dispatchers also hold trip:execute but are staff.
 */
const STAFF_PERMISSIONS = ['driver:read', 'maintenance:read', 'inventory:read', 'fuel-anomaly:read', 'users:read', 'audit:read', 'command:read'] as const

export function isDriverPortalUser(viewer: Viewer): boolean {
  return permits(viewer.permissions, 'trip:execute') && !permits(viewer.permissions, STAFF_PERMISSIONS)
}

export function canOpen(viewer: Viewer, route: AppRoute): boolean {
  return !route.permission || permits(viewer.permissions, route.permission)
}

export interface NavSection {
  portal: Portal
  routes: AppRoute[]
}

/**
 * The menu: each portal's links the viewer may open, sections without any
 * dropped, so nobody sees a link that ends in nothing (FMS-114). Driver
 * portal users get only the driver portal; staff never see it (they hold
 * trip:execute for dispatching, not for driving).
 */
export function navSections(viewer: Viewer): NavSection[] {
  const driver = isDriverPortalUser(viewer)
  return portals
    .filter((portal) => (portal.id === 'driver') === driver)
    .map((portal) => ({ portal, routes: portal.routes.filter((r) => r.nav && canOpen(viewer, r)) }))
    .filter((section) => section.routes.length > 0)
}

/** Where each role starts, most specific first; checked against the viewer's permissions before use. */
const ROLE_HOMES: readonly [role: string, path: string][] = [
  ['admin', '/dashboard'],
  ['fleet_manager', '/dashboard'],
  ['fleet_owner', '/dashboard'],
  ['dispatcher', '/dispatch'],
  ['depot_admin', '/dashboard'],
  ['compliance_officer', '/dashboard'],
  ['technician', '/maintenance'],
  ['finance_clerk', '/fuel-reconciliation'],
  ['driver', '/driver'],
]

const allRoutes = () => portals.flatMap((p) => p.routes)

/**
 * The portal a user lands in when no destination was asked for: a driver on
 * /driver, a dispatcher on /dispatch, a technician on the repair log. Never a
 * screen the user cannot open: the role's home only if its permission holds,
 * else the first link in the user's own menu.
 */
export function homePathFor(viewer: Viewer): string {
  const sections = navSections(viewer)
  const inMenu = new Set(sections.flatMap((s) => s.routes.map((r) => r.path)))
  for (const [role, path] of ROLE_HOMES) {
    if (viewer.roles.includes(role) && inMenu.has(path)) return path
  }
  const first = sections[0]?.routes[0]?.path
  if (first) return first
  // Nothing in any menu (a role with no screens yet): the dashboard, open to any signed-in user.
  return allRoutes().find((r) => r.path === '/dashboard')!.path
}

/** The portal a path belongs to, for the top bar's title. */
export function portalOf(pathname: string): Portal | undefined {
  return portals.find((p) => p.routes.some((r) => pathname === r.path || pathname.startsWith(`${r.path}/`)))
}
