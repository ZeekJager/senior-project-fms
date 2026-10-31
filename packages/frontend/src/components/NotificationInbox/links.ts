import { permits } from '@/lib/permissions'
import { portals } from '@/router/routes'
import type { InboxNotification } from './api'

/** What the link needs to know about who is looking: the session's permissions (/auth/me). */
export interface Viewer {
  permissions: readonly string[]
}

type Subject = Pick<InboxNotification, 'entity' | 'vehicle_id' | 'driver_id'>

/**
 * Where the alert behind a notification is dealt with, by what it is about. The screens take list filters, not
 * record ids, so this is the right list, narrowed to the vehicle when the screen can be (maintenance).
 */
function destination(n: Subject): string | null {
  switch (n.entity?.type) {
    case 'dvir_report':
      return n.vehicle_id ? `/maintenance?vehicle=${encodeURIComponent(n.vehicle_id)}` : '/maintenance'
    case 'maintenance_prediction':
      return '/maintenance'
    case 'vehicle':
      return '/vehicles'
    case 'document':
      // A document belongs to a vehicle or a driver; the alert says which.
      return n.driver_id && !n.vehicle_id ? '/drivers' : '/vehicles'
    case 'driver':
      return '/drivers'
    case 'fuel_anomaly':
      // S-15 opens the anomaly itself (FMS-42).
      return `/fuel-reconciliation?tab=anomalies&anomaly=${encodeURIComponent(n.entity.id)}`
    case 'telemetry_flag':
    case 'incident':
      return '/command-center?view=attention'
    default:
      return null
  }
}

const pathOf = (target: string) => target.split('?')[0]

/**
 * The path a notification opens, or null when it points nowhere (no subject, an unknown kind) or somewhere the
 * viewer may not go: a link that ends in "not allowed" is worse than none, so the notification then only marks
 * itself read.
 */
export function notificationLink(n: Subject, viewer: Viewer): string | null {
  const target = destination(n)
  if (!target) return null
  const route = portals.flatMap((p) => p.routes).find((r) => r.path === pathOf(target))
  if (!route) return null
  return !route.permission || permits(viewer.permissions, route.permission) ? target : null
}
