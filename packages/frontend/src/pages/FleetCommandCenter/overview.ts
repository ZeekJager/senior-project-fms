// The command center's overview (FMS-89, api-contract §11.1): GET /command-center/overview, and what the socket's
// alert and incident events change in it before the next read. Pure, so the live patches are unit-tested.

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type BySeverity = Record<Severity, number>
export type IncidentStatus = 'open' | 'investigating' | 'resolved' | 'closed'

export interface OverviewAlert {
  id: string
  type: string
  severity: Severity
  /** 1 (critical) to 4 (low). */
  priority: number
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed'
  title: string
  message: string | null
  vehicle_id: string | null
  registration_number: string | null
  driver_id: string | null
  entity_type: string | null
  entity_id: string | null
  occurrence_count: number
  escalation_level: number
  created_at: string
  last_occurred_at: string
  acknowledged_at: string | null
}

export interface OverviewIncident {
  id: string
  incident_type: string
  severity: Severity
  status: IncidentStatus
  description: string
  vehicle_id: string | null
  registration_number: string | null
  driver_id: string | null
  driver_name: string | null
  assigned_to: { id: string; full_name: string } | null
  notes: string | null
  latitude: number | null
  longitude: number | null
  occurred_at: string
  updated_at: string
}

export interface Overview {
  depot_id: string | null
  generated_at: string
  vehicles: {
    total: number
    on_trip: number
    available: number
    in_maintenance: number
    inactive: number
    flagged: number
    health: { at_risk: number; watch: number; healthy: number; stale: number; unscored: number }
    health_watch: { vehicle_id: string; registration_number: string; health_score: number; band: 'at_risk' | 'watch' }[]
  }
  drivers: { total: number; on_trip: number; available: number; absent: number; licence_expired: number } | null
  trips: { today: Record<'draft' | 'scheduled' | 'assigned' | 'en_route' | 'completed' | 'cancelled', number>; under_way: number; overdue: number } | null
  alerts: { active: number; unacknowledged: number; by_severity: BySeverity; items: OverviewAlert[] } | null
  incidents: { active: number; by_status: { open: number; investigating: number }; by_severity: BySeverity; items: OverviewIncident[] } | null
}

/** The socket's alert.created (api-contract §11.2). */
export interface AlertCreatedEvent {
  alert_id: string
  depot_id: string | null
  alert_type: string
  severity: Severity
  priority: number
  status: OverviewAlert['status']
  entity_type: string | null
  entity_id: string | null
  vehicle_id: string | null
  title: string
  message: string | null
  created_at: string
}

/** The socket's alert.updated: a repeat, an escalation, an acknowledgement or a resolution. */
export interface AlertUpdatedEvent {
  alert_id: string
  depot_id?: string | null
  status?: OverviewAlert['status']
  severity?: Severity
  priority?: number
  occurrence_count?: number
  last_occurred_at?: string
  escalation_level?: number
  acknowledged_at?: string | null
}

/** The socket's incident.updated (FMS-89). Never the notes: the overview re-read brings them. */
export interface IncidentUpdatedEvent {
  incident_id: string
  depot_id?: string | null
  status: IncidentStatus
  previous_status?: IncidentStatus
  assigned_to?: string | null
  updated_at?: string
}

const ACTIVE_ALERT: ReadonlySet<string> = new Set(['open', 'acknowledged'])
const ACTIVE_INCIDENT: ReadonlySet<string> = new Set(['open', 'investigating'])

const bump = (counts: BySeverity, severity: Severity, by: number): BySeverity => ({ ...counts, [severity]: Math.max(0, counts[severity] + by) })

/** Most severe first, then newest: the order the API lists them in. */
const byPriority = <T extends { severity: Severity; created_at?: string; occurred_at?: string }>(a: T, b: T) =>
  RANK[b.severity] - RANK[a.severity] || Date.parse(b.created_at ?? b.occurred_at ?? '') - Date.parse(a.created_at ?? a.occurred_at ?? '')
const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 }

/** A new alert from the socket, at its place in the list; the counts follow. Already listed: unchanged. */
export function addAlert(overview: Overview, e: AlertCreatedEvent, plateOf: (vehicleId: string) => string | null): Overview {
  const alerts = overview.alerts
  if (!alerts || alerts.items.some((a) => a.id === e.alert_id) || !ACTIVE_ALERT.has(e.status)) return overview
  const item: OverviewAlert = {
    id: e.alert_id,
    type: e.alert_type,
    severity: e.severity,
    priority: e.priority,
    status: e.status,
    title: e.title,
    message: e.message,
    vehicle_id: e.vehicle_id,
    registration_number: e.vehicle_id ? plateOf(e.vehicle_id) : null,
    driver_id: null,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    occurrence_count: 1,
    escalation_level: 0,
    created_at: e.created_at,
    last_occurred_at: e.created_at,
    acknowledged_at: null,
  }
  return {
    ...overview,
    alerts: {
      active: alerts.active + 1,
      unacknowledged: alerts.unacknowledged + (e.status === 'open' ? 1 : 0),
      by_severity: bump(alerts.by_severity, e.severity, 1),
      items: [...alerts.items, item].sort(byPriority),
    },
  }
}

/** A listed alert changed: acknowledged stays with its new state; resolved or dismissed leaves the list. */
export function patchAlert(overview: Overview, e: AlertUpdatedEvent): Overview {
  const alerts = overview.alerts
  const current = alerts?.items.find((a) => a.id === e.alert_id)
  if (!alerts || !current) return overview
  const next: OverviewAlert = {
    ...current,
    ...(e.status ? { status: e.status } : {}),
    ...(e.severity ? { severity: e.severity } : {}),
    ...(e.priority ? { priority: e.priority } : {}),
    ...(e.occurrence_count ? { occurrence_count: e.occurrence_count } : {}),
    ...(e.last_occurred_at ? { last_occurred_at: e.last_occurred_at } : {}),
    ...(e.escalation_level !== undefined ? { escalation_level: e.escalation_level } : {}),
    ...(e.acknowledged_at !== undefined ? { acknowledged_at: e.acknowledged_at } : {}),
  }
  const wasOpen = current.status === 'open' ? 1 : 0
  if (!ACTIVE_ALERT.has(next.status)) {
    return {
      ...overview,
      alerts: {
        active: Math.max(0, alerts.active - 1),
        unacknowledged: Math.max(0, alerts.unacknowledged - wasOpen),
        by_severity: bump(alerts.by_severity, current.severity, -1),
        items: alerts.items.filter((a) => a.id !== e.alert_id),
      },
    }
  }
  return {
    ...overview,
    alerts: {
      active: alerts.active,
      unacknowledged: Math.max(0, alerts.unacknowledged - wasOpen + (next.status === 'open' ? 1 : 0)),
      by_severity: next.severity === current.severity ? alerts.by_severity : bump(bump(alerts.by_severity, current.severity, -1), next.severity, 1),
      items: alerts.items.map((a) => (a.id === e.alert_id ? next : a)).sort(byPriority),
    },
  }
}

/** A new incident (read in full after the socket's incident.created), at its place in the list; the counts follow. */
export function addIncident(overview: Overview, item: OverviewIncident): Overview {
  const incidents = overview.incidents
  if (!incidents || incidents.items.some((i) => i.id === item.id) || !ACTIVE_INCIDENT.has(item.status)) return overview
  const status = item.status as 'open' | 'investigating'
  return {
    ...overview,
    incidents: {
      active: incidents.active + 1,
      by_status: { ...incidents.by_status, [status]: incidents.by_status[status] + 1 },
      by_severity: bump(incidents.by_severity, item.severity, 1),
      items: [...incidents.items, item].sort(byPriority),
    },
  }
}

/** An incident saved here (the PATCH's answer) or changed elsewhere: kept while active, gone once resolved or closed. */
export function patchIncident(overview: Overview, id: string, change: Partial<OverviewIncident> & { status: IncidentStatus }): Overview {
  const incidents = overview.incidents
  const current = incidents?.items.find((i) => i.id === id)
  if (!incidents || !current) return overview
  const next: OverviewIncident = { ...current, ...change }
  const count = (s: IncidentStatus) => (s === 'open' || s === 'investigating' ? s : null)
  const by_status = { ...incidents.by_status }
  const was = count(current.status)
  const now = count(next.status)
  if (was) by_status[was] = Math.max(0, by_status[was] - 1)
  if (now) by_status[now] += 1
  if (!ACTIVE_INCIDENT.has(next.status)) {
    return {
      ...overview,
      incidents: {
        active: Math.max(0, incidents.active - 1),
        by_status,
        by_severity: bump(incidents.by_severity, current.severity, -1),
        items: incidents.items.filter((i) => i.id !== id),
      },
    }
  }
  return { ...overview, incidents: { ...incidents, by_status, items: incidents.items.map((i) => (i.id === id ? next : i)) } }
}

/** Plain words for an incident's type (the driver form's, FMS-38). */
export const INCIDENT_TYPE_LABELS: Record<string, string> = {
  accident: 'Accident',
  breakdown: 'Breakdown',
  tyre: 'Tyre',
  theft: 'Theft',
  vandalism: 'Vandalism',
  injury: 'Injury',
  road_hazard: 'Road hazard',
  other: 'Other',
}

export const incidentTypeLabel = (type: string) => INCIDENT_TYPE_LABELS[type] ?? type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** Where an incident may go from each status (api-contract §12.2): closed is final, a resolved one may be reopened. */
export const INCIDENT_NEXT: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ['investigating', 'resolved', 'closed'],
  investigating: ['resolved', 'closed'],
  resolved: ['investigating', 'closed'],
  closed: [],
}

/** "Just now", "4 min ago", "2 h ago", "3 days ago". */
export function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'Just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
