import { describe, expect, it } from 'vitest'
import { etaEventOf, etaSummary, formatKm, isEtaStale, timeUntil, type TripEta } from './format'

// 14:00 in Addis Ababa (UTC+3).
const NOW = Date.parse('2026-11-02T11:00:00Z')
const eta = (patch: Partial<TripEta> = {}): TripEta => ({
  arrival_at: '2026-11-02T11:32:00Z',
  remaining_km: 12.44,
  next_stop: { stop_id: 's1', name: 'Mojo', eta: '2026-11-02T11:05:00Z' },
  position_at: '2026-11-02T10:59:30Z',
  updated_at: '2026-11-02T10:59:31Z',
  ...patch,
})

describe('arrival times on screen (FMS-86)', () => {
  it('says when the trip arrives and how far is left, or the next stop without a destination time', () => {
    expect(etaSummary(eta())).toBe('Arrives 14:32 · 12.4 km to go')
    expect(etaSummary(eta({ arrival_at: null }))).toBe('Mojo 14:05')
    expect(etaSummary(eta({ arrival_at: '2026-11-02T10:58:00Z', remaining_km: 0, next_stop: null }))).toBe('Arrived 13:58')
    expect(etaSummary(eta({ arrival_at: null, next_stop: null }))).toBeNull()
    expect(etaSummary(null)).toBeNull()
  })

  it('distances and time left read naturally', () => {
    expect(formatKm(0.35)).toBe('350 m')
    expect(formatKm(12.44)).toBe('12.4 km')
    expect(formatKm(128.6)).toBe('129 km')
    expect(timeUntil('2026-11-02T11:38:00Z', NOW)).toBe('in 38 min')
    expect(timeUntil('2026-11-02T12:05:00Z', NOW)).toBe('in 1 h 5 min')
    expect(timeUntil('2026-11-02T13:00:00Z', NOW)).toBe('in 2 h')
    expect(timeUntil('2026-11-02T10:59:50Z', NOW)).toBe('due now')
  })

  it('an estimate from a position over 2 minutes old is stale', () => {
    expect(isEtaStale(eta(), NOW)).toBe(false)
    expect(isEtaStale(eta({ position_at: '2026-11-02T10:57:00Z' }), NOW)).toBe(true)
    // The live map's snapshot has no position time: its updated_at stands in.
    expect(isEtaStale(eta({ position_at: undefined, updated_at: '2026-11-02T10:50:00Z' }), NOW)).toBe(true)
  })

  it('reads a new estimate from trip.updated, and nothing from any other change', () => {
    expect(etaEventOf({ trip_id: 't1', depot_id: 'd1', change: 'TripEtaUpdated', eta: eta() })).toEqual({ trip_id: 't1', depot_id: 'd1', eta: eta() })
    expect(etaEventOf({ trip_id: 't1', change: 'TripStarted' })).toBeNull()
    expect(etaEventOf(null)).toBeNull()
  })
})
