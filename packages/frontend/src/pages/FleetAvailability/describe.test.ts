import { describe, expect, it } from 'vitest'
import type { VehicleAvailability } from './api'
import { readState, writeState } from './api'
import { hours, mainReason, minutesInMonth, sortRows, span } from './describe'

// FMS-142: the screen's lengths of time, sorting and URL state.

const none = { planned_service: 0, unplanned_repair: 0, breakdown: 0, accident: 0, awaiting_parts: 0, other: 0 }
const row = (plate: string, downtime: number, mtbf: number | null): VehicleAvailability => ({
  vehicle_id: plate,
  registration_number: plate,
  depot_id: 'd',
  depot_name: 'Bole',
  status: 'active',
  in_fleet_minutes: 43_200,
  uptime_minutes: 43_200 - downtime,
  downtime_minutes: downtime,
  unplanned_downtime_minutes: 0,
  availability_pct: Math.round(((43_200 - downtime) * 1000) / 43_200) / 10,
  failures: mtbf === null ? 0 : 1,
  mtbf_minutes: mtbf,
  repairs: 0,
  mttr_minutes: null,
  downtime_by_reason: { ...none, other: downtime },
})

describe('lengths of time', () => {
  it('a span reads in minutes, hours, then days and hours', () => {
    expect(span(null)).toBe('—')
    expect(span(45)).toBe('45 min')
    expect(span(320)).toBe('5 h 20 min')
    expect(span(1_080)).toBe('18 h')
    expect(span(19_080)).toBe('13 d 6 h')
    expect(span(2_880)).toBe('2 d')
  })

  it('a month’s downtime is in hours once there is an hour of it', () => {
    expect(hours(30)).toBe('30 min')
    expect(hours(90)).toBe('1.5 h')
    expect(hours(5_040)).toBe('84 h')
    expect(hours(74_430)).toBe('1,241 h')
  })

  it('only the part of a period inside the month counts toward it, to now while it lasts', () => {
    const now = new Date('2026-09-15T12:00:00+03:00')
    expect(minutesInMonth({ started_at: '2026-08-31T20:00:00+03:00', ended_at: '2026-09-01T01:00:00+03:00' }, '2026-09', now)).toBe(60)
    expect(minutesInMonth({ started_at: '2026-09-15T10:00:00+03:00', ended_at: null }, '2026-09', now)).toBe(120)
    expect(minutesInMonth({ started_at: '2026-09-30T23:00:00+03:00', ended_at: '2026-10-01T02:00:00+03:00' }, '2026-09', new Date('2026-10-05T00:00:00Z'))).toBe(60)
  })
})

describe('sorting and the reason', () => {
  it('sorts by a figure with ties by plate, a vehicle with no figure last either way', () => {
    const rows = [row('C', 0, null), row('A', 600, 2_000), row('B', 600, 9_000)]
    expect(sortRows(rows, 'downtime', 'desc').map((r) => r.registration_number)).toEqual(['A', 'B', 'C'])
    expect(sortRows(rows, 'mtbf', 'asc').map((r) => r.registration_number)).toEqual(['A', 'B', 'C'])
    expect(sortRows(rows, 'mtbf', 'desc').map((r) => r.registration_number)).toEqual(['B', 'A', 'C'])
    expect(sortRows(rows, 'plate', 'desc').map((r) => r.registration_number)).toEqual(['C', 'B', 'A'])
  })

  it('the main reason is the one with the most minutes, none for a vehicle never down', () => {
    expect(mainReason({ downtime_by_reason: { ...none, breakdown: 720, planned_service: 2_880 } })).toBe('planned_service')
    expect(mainReason({ downtime_by_reason: none })).toBeNull()
  })
})

describe('the URL', () => {
  const now = new Date('2026-11-05T09:00:00+03:00')

  it('defaults to this month, most downtime first, and leaves defaults out', () => {
    const s = readState(new URLSearchParams(), now)
    expect(s).toEqual({ month: '2026-11', depotId: '', view: 'all', sort: 'downtime', order: 'desc', vehicle: '' })
    expect(writeState(s, now).toString()).toBe('')
  })

  it('keeps a past month, a sort and the vehicle open; never a month not yet begun', () => {
    const s = readState(new URLSearchParams('month=2026-09&sort=mtbf&vehicle=v-1&view=down'), now)
    expect(s).toMatchObject({ month: '2026-09', sort: 'mtbf', order: 'asc', vehicle: 'v-1', view: 'down' })
    expect(writeState(s, now).toString()).toBe('month=2026-09&view=down&sort=mtbf&vehicle=v-1')
    expect(readState(new URLSearchParams('month=2027-01'), now).month).toBe('2026-11')
  })
})
