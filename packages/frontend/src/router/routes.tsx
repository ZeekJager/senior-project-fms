import { Boxes, CalendarCheck, ClipboardCheck, Fuel, Home, LayoutDashboard, Radar, Route, Truck, UserCog, Users, Waypoints, Wrench, type LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import type { PermissionRule } from '@/lib/permissions'
import { AttendancePage } from '@/pages/Attendance'
import { DriversPage } from '@/pages/Drivers'
import { InventoryPage } from '@/pages/Inventory'
import { MaintenancePage } from '@/pages/Maintenance'
import { DispatchPage } from '@/pages/Dispatch'
import { DriverFuel, DriverHome, DriverInspection } from '@/pages/Driver'
import { CommandCenterPage, DashboardPage, FuelReconciliationPage } from '@/pages/placeholders'
import { RoutesPage } from '@/pages/Routes'
import { UsersPage } from '@/pages/Users'
import { VehiclesPage } from '@/pages/Vehicles'

export interface AppRoute {
  path: string
  element: ReactElement
  /** Permission code(s) from /auth/me: one, any of a list, or `{ all: [...] }`. Omit for any signed-in user. */
  permission?: PermissionRule
  /** Shown in the menu when set and the user holds the permission. */
  nav?: { label: string; icon: LucideIcon }
}

export type PortalId = 'fleet' | 'command' | 'admin' | 'driver'

export interface Portal {
  id: PortalId
  /** The menu section heading. */
  name: string
  routes: AppRoute[]
}

/**
 * The route table: the four portals of the architecture (§6, §7), each a
 * menu section. Permissions are the codes seeded in auth.permissions, the
 * same ones the API enforces; the menu shows a link only to a user who holds
 * its permission, and a section only when it has such a link (FMS-114). A
 * new screen is a line here.
 */
export const portals: Portal[] = [
  {
    id: 'fleet',
    name: 'Fleet management',
    routes: [
      { path: '/dashboard', element: <DashboardPage />, nav: { label: 'Dashboard', icon: LayoutDashboard } },
      {
        // S-04. Drivers hold vehicle:read for their own vehicle but not
        // depot:read, so the fleet-wide view needs both (FMS-18).
        path: '/vehicles',
        element: <VehiclesPage />,
        permission: { all: ['vehicle:read', 'depot:read'] },
        nav: { label: 'Vehicles', icon: Truck },
      },
      {
        // S-05. driver:read is staff-only: drivers see their own profile at /drivers/me instead (FMS-19).
        path: '/drivers',
        element: <DriversPage />,
        permission: 'driver:read',
        nav: { label: 'Drivers', icon: Users },
      },
      {
        // S-06. Staff with attendance:read (a dispatcher reads, a depot admin also writes);
        // drivers hold attendance rights for their own day but not driver:read (FMS-21).
        path: '/attendance',
        element: <AttendancePage />,
        permission: { all: ['attendance:read', 'driver:read'] },
        nav: { label: 'Attendance', icon: CalendarCheck },
      },
      {
        // S-08. Technicians log repairs; depot admins and fleet managers also read and write (FMS-24).
        path: '/maintenance',
        element: <MaintenancePage />,
        permission: 'maintenance:read',
        nav: { label: 'Repair log', icon: Wrench },
      },
      {
        // S-09. inventory:read: admin, fleet manager, depot admin, technician (FMS-25).
        path: '/inventory',
        element: <InventoryPage />,
        permission: 'inventory:read',
        nav: { label: 'Spare parts', icon: Boxes },
      },
      {
        // Route planning (FMS-83). Dispatchers, depot admins and fleet managers write
        // (route:write). Drivers hold route:read for their trips but not depot:read,
        // so, as for vehicles, the planning screen needs both.
        path: '/routes',
        element: <RoutesPage />,
        permission: { all: ['route:read', 'depot:read'] },
        nav: { label: 'Routes', icon: Waypoints },
      },
      {
        path: '/fuel-reconciliation',
        element: <FuelReconciliationPage />,
        permission: 'fuel-anomaly:read',
        nav: { label: 'Fuel reconciliation', icon: Fuel },
      },
    ],
  },
  {
    id: 'command',
    name: 'Command center',
    routes: [
      // S-07, the dispatcher's home. trip:assign: admin, fleet manager, dispatcher.
      { path: '/dispatch', element: <DispatchPage />, permission: 'trip:assign', nav: { label: 'Dispatch', icon: Route } },
      // S-16. command:read: admin, fleet manager, dispatcher, depot admin, fleet owner.
      { path: '/command-center', element: <CommandCenterPage />, permission: 'command:read', nav: { label: 'Live map', icon: Radar } },
    ],
  },
  {
    id: 'admin',
    name: 'Administration',
    routes: [
      {
        // User and role administration (FMS-78). users:read: admin, fleet manager,
        // compliance officer read; only admin (users:write) changes accounts.
        path: '/users',
        element: <UsersPage />,
        permission: 'users:read',
        nav: { label: 'Users & roles', icon: UserCog },
      },
    ],
  },
  {
    id: 'driver',
    name: 'Driver',
    routes: [
      // S-11 (FMS-35): today's trip, START and END.
      { path: '/driver', element: <DriverHome />, permission: 'trip:execute', nav: { label: 'My day', icon: Home } },
      // S-12 (FMS-37): the pre- and post-trip inspection, submitted through the offline queue.
      { path: '/driver/dvir', element: <DriverInspection />, permission: 'dvir:write', nav: { label: 'Inspection', icon: ClipboardCheck } },
      // S-14 (FMS-40): a fill-up at the pump, submitted through the offline queue.
      { path: '/driver/fuel', element: <DriverFuel />, permission: 'fuel:write', nav: { label: 'Fuel', icon: Fuel } },
    ],
  },
]
