import { describe, expect, it } from 'vitest'
import { IDLE_AFTER_MS, OFFLINE_AFTER_MS, lastSeenLabel, markerState, trackStops, type FleetMapVehicle } from './markerState'

const NOW = Date.parse('2026-10-21T09:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const vehicle = (over: Partial<FleetMapVehicle> = {}): FleetMapVehicle => ({
  vehicleId: 'v1',
  lat: 9.01,
  lng: 38.76,
  speedKmh: 42,
  lastSeen: iso(5_000),
  ...over,
})

describe('markerState', () => {
  it('is moving while pings report a speed', () => {
    expect(markerState(vehicle(), NOW, null)).toBe('moving')
  })

  it('is idling (amber) only once stopped for more than 5 minutes', () => {
    const stopped = vehicle({ speedKmh: 0 })
    expect(markerState(stopped, NOW, null)).toBe('stopped')
    expect(markerState(stopped, NOW, NOW - IDLE_AFTER_MS)).toBe('stopped')
    expect(markerState(stopped, NOW, NOW - IDLE_AFTER_MS - 1)).toBe('idling')
  })

  it('is offline (grey) once the last ping is more than 2 minutes old, whatever it said', () => {
    expect(markerState(vehicle({ lastSeen: iso(OFFLINE_AFTER_MS) }), NOW, null)).toBe('moving')
    expect(markerState(vehicle({ lastSeen: iso(OFFLINE_AFTER_MS + 1) }), NOW, null)).toBe('offline')
    expect(markerState(vehicle({ speedKmh: 0, lastSeen: iso(OFFLINE_AFTER_MS + 1) }), NOW, NOW - IDLE_AFTER_MS * 3)).toBe('offline')
    expect(markerState(vehicle({ lastSeen: 'not a time' }), NOW, null)).toBe('offline')
  })

  it('shows a speeding flag above moving and idling, but not over an out-of-date position', () => {
    expect(markerState(vehicle({ speeding: true, speedKmh: 95 }), NOW, null)).toBe('speeding')
    expect(markerState(vehicle({ speeding: true, speedKmh: 0 }), NOW, NOW - IDLE_AFTER_MS * 2)).toBe('speeding')
    expect(markerState(vehicle({ speeding: true, lastSeen: iso(OFFLINE_AFTER_MS + 1) }), NOW, null)).toBe('offline')
    expect(markerState(vehicle({ speeding: true, breakdown: true }), NOW, null)).toBe('breakdown')
  })

  it('shows a breakdown above everything, even when the phone has gone quiet', () => {
    expect(markerState(vehicle({ breakdown: true, lastSeen: iso(OFFLINE_AFTER_MS * 10) }), NOW, null)).toBe('breakdown')
  })

  it('does not count a ping without a speed as stopped', () => {
    expect(markerState(vehicle({ speedKmh: null }), NOW, NOW - IDLE_AFTER_MS * 2)).toBe('moving')
  })
})

describe('trackStops', () => {
  it('keeps the time of the first 0 km/h ping in a run, and forgets it when the vehicle moves', () => {
    const first = trackStops(new Map(), [vehicle({ speedKmh: 0, lastSeen: iso(60_000) })])
    expect(first.get('v1')).toBe(NOW - 60_000)
    const still = trackStops(first, [vehicle({ speedKmh: 0, lastSeen: iso(1_000) })])
    expect(still.get('v1')).toBe(NOW - 60_000)
    expect(trackStops(still, [vehicle({ speedKmh: 3 })]).has('v1')).toBe(false)
    expect(trackStops(still, [vehicle({ speedKmh: null })]).has('v1')).toBe(false)
  })

  it("prefers the server's stoppedSince and drops vehicles no longer on the map", () => {
    const server = iso(20 * 60_000)
    const stops = trackStops(new Map([['gone', NOW]]), [vehicle({ speedKmh: 0, stoppedSince: server })])
    expect(stops.get('v1')).toBe(Date.parse(server))
    expect(stops.has('gone')).toBe(false)
  })
})

describe('lastSeenLabel', () => {
  it('reads as a short relative time', () => {
    expect(lastSeenLabel(iso(3_000), NOW)).toBe('Just now')
    expect(lastSeenLabel(iso(45_000), NOW)).toBe('45 s ago')
    expect(lastSeenLabel(iso(3 * 60_000 + 20_000), NOW)).toBe('3 min ago')
    expect(lastSeenLabel(iso(2 * 3_600_000), NOW)).toBe('2 h ago')
    expect(lastSeenLabel(iso(-5_000), NOW)).toBe('Just now')
    expect(lastSeenLabel('', NOW)).toBe('Never')
    expect(lastSeenLabel(iso(3 * 86_400_000), NOW)).toMatch(/18/)
  })
})
