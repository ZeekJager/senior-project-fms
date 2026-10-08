import type { ReactElement } from 'react'
import { DashboardPage, DriverHomePage, FuelReconciliationPage } from '@/pages/placeholders'

export interface AppRoute {
  path: string
  element: ReactElement
  /** Permission code(s) from /auth/me; any one grants access. Omit for any signed-in user. */
  permission?: string | readonly string[]
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
      { path: '/dashboard', element: <DashboardPage /> },
      { path: '/fuel-reconciliation', element: <FuelReconciliationPage />, permission: 'fuel-anomaly:read' },
    ],
  },
  {
    name: 'driver',
    routes: [{ path: '/driver', element: <DriverHomePage />, permission: 'trip:execute' }],
  },
]
