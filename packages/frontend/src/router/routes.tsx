import { Activity, Boxes, CalendarCheck, CalendarClock, ClipboardCheck, Fuel, Home, LayoutDashboard, Radar, Route, ScrollText, Siren, Truck, UserCog, Users, Waypoints, Wrench, type LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { Navigate } from 'react-router-dom'
import type { PermissionRule } from '@/lib/permissions'
import { AttendancePage } from '@/pages/Attendance'
import { AuditLogPage } from '@/pages/AuditLog'
import { DriversPage } from '@/pages/Drivers'
import { InventoryPage } from '@/pages/Inventory'
import { MaintenancePage } from '@/pages/Maintenance'
import { PredictiveMaintenancePage } from '@/pages/PredictiveMaintenance'
import { DispatchPage } from '@/pages/Dispatch'
import { DriverFuel, DriverHome, DriverIncident, DriverInspection } from '@/pages/Driver'
import { CommandCenterPage } from '@/pages/FleetCommandCenter'
import { FuelReconciliationPage } from '@/pages/FuelReconciliation'
import { DashboardPage } from '@/pages/placeholders'
import { RoutesPage } from '@/pages/Routes'
import { ServiceProgramsPage } from '@/pages/ServicePrograms'
import { UsersPage } from '@/pages/Users'
import { VehicleHistoryPage } from '@/pages/VehicleHistory'
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
      // S-18 (FMS-51) is the dashboard for analytics:read; /analytics is the screen inventory's name for it.
      { path: '/dashboard', element: <DashboardPage />, nav: { label: 'Dashboard', icon: LayoutDashboard } },
      { path: '/analytics', element: <Navigate to="/dashboard" replace /> },
      {
        // S-04. Drivers hold vehicle:read for their own vehicle but not
        // depot:read, so the fleet-wide view needs both (FMS-18).
        path: '/vehicles',
        element: <VehiclesPage />,
        permission: { all: ['vehicle:read', 'depot:read'] },
        nav: { label: 'Vehicles', icon: Truck },
      },
      {
        // S-22. One vehicle's history (FMS-136), opened from the list; each section needs its own read permission.
        path: '/vehicles/:vehicleId',
        element: <VehicleHistoryPage />,
        permission: { all: ['vehicle:read', 'depot:read'] },
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
        // S-23 (FMS-129). Read with maintenance:read; defined with service-program:write (admin, fleet manager, depot admin).
        path: '/service-programs',
        element: <ServiceProgramsPage />,
        permission: 'maintenance:read',
        nav: { label: 'Service programs', icon: CalendarClock },
      },
      {
        // S-19 (FMS-56). prediction:read: admin, fleet manager, depot admin, technician, compliance officer, fleet owner.
        // Dispatchers see a vehicle's health badge on Vehicles, not this screen or the breakdown.
        path: '/predictive-maintenance',
        element: <PredictiveMaintenancePage />,
        permission: 'prediction:read',
        nav: { label: 'Vehicle health', icon: Activity },
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
        // S-15 (FMS-42). The anomalies need fuel-anomaly:read (admin, fleet manager, depot admin, finance clerk,
        // compliance officer); the vehicle table also analytics:read and fuel:read, so a depot admin sees anomalies only.
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
      // S-16 (FMS-45). command:read: admin, fleet manager, dispatcher, depot admin, fleet owner; each
      // also holds tracking:read, which the positions need (GET /tracking/vehicles/current).
      {
        path: '/command-center',
        element: <CommandCenterPage />,
        permission: { all: ['command:read', 'tracking:read'] },
        nav: { label: 'Live map', icon: Radar },
      },
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
      {
        // S-10 (FMS-29). audit:read: admin, fleet owner, compliance officer (migration 025 took it from fleet managers).
        path: '/audit',
        element: <AuditLogPage />,
        permission: 'audit:read',
        nav: { label: 'Audit log', icon: ScrollText },
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
      // S-13 (FMS-38): an incident, reported from wherever the driver is, through the offline queue.
      { path: '/driver/incident', element: <DriverIncident />, permission: 'incident:write', nav: { label: 'Incident', icon: Siren } },
    ],
  },
]
