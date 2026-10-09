import { Fuel, Home, LayoutDashboard, Truck, type LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import type { PermissionRule } from '@/context/AuthContext'
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
        path: '/fuel-reconciliation',
        element: <FuelReconciliationPage />,
        permission: 'fuel-anomaly:read',
        nav: { label: 'Fuel reconciliation', icon: Fuel },
      },
    ],
  },
  {
    name: 'driver',
    routes: [{ path: '/driver', element: <DriverHomePage />, permission: 'trip:execute', nav: { label: 'My day', icon: Home } }],
  },
]
