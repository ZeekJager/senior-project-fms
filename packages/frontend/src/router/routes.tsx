import { Boxes, CalendarCheck, Fuel, Home, LayoutDashboard, Truck, UserCog, Users, Wrench, type LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import type { PermissionRule } from '@/context/AuthContext'
import { AttendancePage } from '@/pages/Attendance'
import { DriversPage } from '@/pages/Drivers'
import { InventoryPage } from '@/pages/Inventory'
import { MaintenancePage } from '@/pages/Maintenance'
import { UsersPage } from '@/pages/Users'
import { DashboardPage, DriverHomePage, FuelReconciliationPage } from '@/pages/placeholders'
import { VehiclesPage } from '@/pages/Vehicles'

export interface AppRoute {
  path: string
  element: ReactElement
  /** Permission code(s) from /auth/me: one, any of a list, or `{ all: [...] }`. Omit for any signed-in user. */
  permission?: PermissionRule
  /** Shown in the sidebar when set (and the user holds the permission). */
  nav?: { label: string; icon: LucideIcon }
}

export interface Portal {
  name: string
  routes: AppRoute[]
}

/**
 * The route table, one entry per portal. Permissions are the codes seeded in
 * auth.permissions (migration 001), the same ones the API enforces. A new
 * screen is a line here.
 */
export const portals: Portal[] = [
  {
    name: 'staff',
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
        path: '/fuel-reconciliation',
        element: <FuelReconciliationPage />,
        permission: 'fuel-anomaly:read',
        nav: { label: 'Fuel reconciliation', icon: Fuel },
      },
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
    name: 'driver',
    routes: [{ path: '/driver', element: <DriverHomePage />, permission: 'trip:execute', nav: { label: 'My day', icon: Home } }],
  },
]
