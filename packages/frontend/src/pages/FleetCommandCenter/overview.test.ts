import { describe, expect, it } from 'vitest'
import { addAlert, addIncident, ago, patchAlert, patchIncident, type Overview, type OverviewAlert, type OverviewIncident } from './overview'

const alertItem = (id: string, extra: Partial<OverviewAlert> = {}): OverviewAlert => ({
  id,
  type: 'vehicle_fault',
  severity: 'high',
  priority: 2,
  status: 'open',
  title: `Alert ${id}`,
  message: null,
  vehicle_id: null,
  registration_number: null,
  driver_id: null,
  entity_type: null,
  entity_id: null,
  occurrence_count: 1,
  escalation_level: 0,
  created_at: '2026-10-30T08:00:00Z',
  last_occurred_at: '2026-10-30T08:00:00Z',
  acknowledged_at: null,
  ...extra,
})

const incidentItem = (id: string, extra: Partial<OverviewIncident> = {}): OverviewIncident => ({
  id,
  incident_type: 'breakdown',
  severity: 'medium',
  status: 'open',
  description: 'Engine stalled',
  vehicle_id: null,
  registration_number: null,
  driver_id: null,
  driver_name: null,
  assigned_to: null,
  notes: null,
  latitude: null,
  longitude: null,
  occurred_at: '2026-10-30T08:00:00Z',
  updated_at: '2026-10-30T08:00:00Z',
  ...extra,
})

function overview(alerts: OverviewAlert[], incidents: OverviewIncident[]): Overview {
  const sev = { critical: 0, high: 0, medium: 0, low: 0 }
  return {
    depot_id: null,
    generated_at: '2026-10-30T09:00:00Z',
    vehicles: { total: 0, on_trip: 0, available: 0, in_maintenance: 0, inactive: 0, flagged: 0, health: { at_risk: 0, watch: 0, healthy: 0, stale: 0, unscored: 0 }, health_watch: [] },
    drivers: null,
    trips: null,
    alerts: {
      active: alerts.length,
      unacknowledged: alerts.filter((a) => a.status === 'open').length,
      by_severity: alerts.reduce((s, a) => ({ ...s, [a.severity]: s[a.severity] + 1 }), sev),
      items: alerts,
    },
    incidents: {
      active: incidents.length,
      by_status: { open: incidents.filter((i) => i.status === 'open').length, investigating: incidents.filter((i) => i.status === 'investigating').length },
      by_severity: incidents.reduce((s, i) => ({ ...s, [i.severity]: s[i.severity] + 1 }), sev),
      items: incidents,
    },
  }
}

describe('live alerts', () => {
  it('a new critical alert goes to the top, with its plate, and is counted; a repeat of it changes nothing', () => {
    const before = overview([alertItem('a1')], [])
    const event = {
      alert_id: 'a2',
      depot_id: null,
      alert_type: 'incident',
      severity: 'critical' as const,
      priority: 1,
      status: 'open' as const,
      entity_type: 'incident',
      entity_id: 'i1',
      vehicle_id: 'v1',
      title: 'Critical incident',
      message: null,
      created_at: '2026-10-30T07:00:00Z',
    }
    const after = addAlert(before, event, (id) => (id === 'v1' ? 'AA 3-10001' : null))
    expect(after.alerts!.items.map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(after.alerts!.items[0].registration_number).toBe('AA 3-10001')
    expect(after.alerts).toMatchObject({ active: 2, unacknowledged: 2, by_severity: { critical: 1, high: 1 } })
    expect(addAlert(after, event, () => null)).toBe(after)
  })

  it('acknowledging keeps it listed and counts it as no longer open; resolving takes it off', () => {
    const before = overview([alertItem('a1'), alertItem('a2', { severity: 'low' })], [])
    const acked = patchAlert(before, { alert_id: 'a1', status: 'acknowledged', acknowledged_at: '2026-10-30T09:01:00Z' })
    expect(acked.alerts).toMatchObject({ active: 2, unacknowledged: 1 })
    expect(acked.alerts!.items[0]).toMatchObject({ id: 'a1', status: 'acknowledged', acknowledged_at: '2026-10-30T09:01:00Z' })

    const resolved = patchAlert(acked, { alert_id: 'a1', status: 'resolved' })
    expect(resolved.alerts).toMatchObject({ active: 1, unacknowledged: 1, by_severity: { high: 0, low: 1 } })
    expect(resolved.alerts!.items.map((a) => a.id)).toEqual(['a2'])
    // An alert not listed (another depot's) changes nothing.
    expect(patchAlert(resolved, { alert_id: 'elsewhere', status: 'resolved' })).toBe(resolved)
  })
})

describe('live incidents', () => {
  it('a new one is counted by status and severity; resolving one takes it off; investigating moves its count', () => {
    let o = overview([], [incidentItem('i1')])
    o = addIncident(o, incidentItem('i2', { severity: 'critical' }))
    expect(o.incidents).toMatchObject({ active: 2, by_status: { open: 2, investigating: 0 }, by_severity: { critical: 1, medium: 1 } })
    expect(o.incidents!.items.map((i) => i.id)).toEqual(['i2', 'i1'])

    o = patchIncident(o, 'i1', { status: 'investigating', assigned_to: { id: 'u-1', full_name: 'Sam Tester' } })
    expect(o.incidents).toMatchObject({ active: 2, by_status: { open: 1, investigating: 1 } })
    expect(o.incidents!.items.find((i) => i.id === 'i1')!.assigned_to?.full_name).toBe('Sam Tester')

    o = patchIncident(o, 'i2', { status: 'resolved' })
    expect(o.incidents).toMatchObject({ active: 1, by_status: { open: 0, investigating: 1 }, by_severity: { critical: 0 } })
    expect(o.incidents!.items.map((i) => i.id)).toEqual(['i1'])
  })
})

describe('ago', () => {
  it('says how long ago in plain words', () => {
    const now = Date.parse('2026-10-30T12:00:00Z')
    expect(ago('2026-10-30T11:59:30Z', now)).toBe('Just now')
    expect(ago('2026-10-30T11:56:00Z', now)).toBe('4 min ago')
    expect(ago('2026-10-30T10:00:00Z', now)).toBe('2 h ago')
    expect(ago('2026-10-29T12:00:00Z', now)).toBe('1 day ago')
  })
})
