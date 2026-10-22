import { describe, expect, it } from 'vitest'
import { applyPositions, liveState, mergeSnapshot, needsAttention, routeLabel, toMapVehicle } from './liveFleet'
import type { LocationUpdate, VehicleLocation } from './types'

const NOW = Date.parse('2026-10-21T09:00:00Z')
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

function vehicle(overrides: Partial<VehicleLocation> = {}): VehicleLocation {
  return {
    vehicle_id: 'v-1',
    registration_number: 'AA 3-10001',
    vehicle_type: 'truck',
    vehicle_status: 'active',
    maintenance_flag: false,
    depot_id: 'd-1',
    position: { lat: 9, lng: 38.7, speed_kmh: 40, heading: 90, accuracy_m: 5, ignition_on: true, recorded_at: at(20), stopped_since: null },
    trip: { trip_id: 't-1', route_name: 'Bole - Adama', origin: 'Bole', destination: 'Adama', started_at: at(3600), scheduled_end: null, driver: { driver_id: 'dr-1', full_name: 'Abebe Kebede' } },
    flags: [],
    ...overrides,
  }
}

const update = (overrides: Partial<LocationUpdate> = {}): LocationUpdate => ({
  vehicle_id: 'v-1',
  depot_id: 'd-1',
  trip_id: 't-1',
  lat: 9.01,
  lng: 38.71,
  speed: 55,
  heading: 80,
  recorded_at: at(5),
  ...overrides,
})

const fleetOf = (...vs: VehicleLocation[]) => new Map(vs.map((v) => [v.vehicle_id, v]))

describe('mergeSnapshot', () => {
  it('keeps a position the socket brought that is newer than the (cached) snapshot', () => {
    const live = vehicle({ position: { ...vehicle().position!, lat: 9.5, recorded_at: at(2) } })
    const merged = mergeSnapshot(fleetOf(live), [vehicle()])
    expect(merged.get('v-1')!.position!.lat).toBe(9.5)
  })

  it('takes the snapshot when it is newer, and drops vehicles it no longer lists', () => {
    const old = vehicle({ position: { ...vehicle().position!, lat: 1, recorded_at: at(60) } })
    const gone = vehicle({ vehicle_id: 'v-gone' })
    const merged = mergeSnapshot(fleetOf(old, gone), [vehicle()])
    expect(merged.get('v-1')!.position!.lat).toBe(9)
    expect(merged.has('v-gone')).toBe(false)
  })
})

describe('applyPositions', () => {
  it('moves a vehicle to its newer position', () => {
    const { fleet, changed, stale } = applyPositions(fleetOf(vehicle()), [update()])
    expect(changed).toBe(true)
    expect(stale).toEqual([])
    expect(fleet.get('v-1')!.position).toMatchObject({ lat: 9.01, lng: 38.71, speed_kmh: 55, heading: 80, recorded_at: at(5) })
  })

  it('drops a late position, older than the one shown', () => {
    const { fleet, changed } = applyPositions(fleetOf(vehicle()), [update({ recorded_at: at(30), lat: 1 })])
    expect(changed).toBe(false)
    expect(fleet.get('v-1')!.position!.lat).toBe(9)
  })

  it('counts a stop from its first 0 km/h position, and clears it when the vehicle moves', () => {
    let { fleet } = applyPositions(fleetOf(vehicle()), [update({ speed: 0, recorded_at: at(15) })])
    expect(fleet.get('v-1')!.position!.stopped_since).toBe(at(15))
    fleet = applyPositions(fleet, [update({ speed: 0, recorded_at: at(10) })]).fleet
    expect(fleet.get('v-1')!.position!.stopped_since).toBe(at(15))
    fleet = applyPositions(fleet, [update({ speed: 20, recorded_at: at(5) })]).fleet
    expect(fleet.get('v-1')!.position!.stopped_since).toBeNull()
  })

  it('asks for a fresh snapshot for a vehicle it does not know, or whose trip changed', () => {
    expect(applyPositions(fleetOf(vehicle()), [update({ vehicle_id: 'v-new' })]).stale).toEqual(['v-new'])
    const tripEnded = applyPositions(fleetOf(vehicle()), [update({ trip_id: null })])
    expect(tripEnded.stale).toEqual(['v-1'])
    // The position is still shown meanwhile.
    expect(tripEnded.fleet.get('v-1')!.position!.lat).toBe(9.01)
  })

  it('gives a vehicle on a trip its first position', () => {
    const { fleet } = applyPositions(fleetOf(vehicle({ position: null })), [update()])
    expect(fleet.get('v-1')!.position).toMatchObject({ lat: 9.01, stopped_since: null })
  })
})

describe('what the map and the list show', () => {
  it('maps a vehicle with its driver and route for the popup, and flags speeding', () => {
    const mapped = toMapVehicle(vehicle({ flags: [{ flag_type: 'speeding', severity: 'high', observed_at: at(10) }] }))
    expect(mapped).toMatchObject({ vehicleId: 'v-1', plateNumber: 'AA 3-10001', speedKmh: 40, speeding: true })
    expect(mapped!.details).toEqual([
      { label: 'Driver', value: 'Abebe Kebede' },
      { label: 'Route', value: 'Bole - Adama' },
    ])
    expect(toMapVehicle(vehicle({ position: null }))).toBeNull()
  })

  it('names a route by the trip when it has none', () => {
    expect(routeLabel({ ...vehicle().trip!, route_name: null })).toBe('Bole → Adama')
    expect(routeLabel(null)).toBeNull()
  })

  it('states: moving, offline after 2 minutes, speeding, no signal; which need attention', () => {
    expect(liveState(vehicle(), NOW)).toBe('moving')
    expect(liveState(vehicle({ position: { ...vehicle().position!, recorded_at: at(121) } }), NOW)).toBe('offline')
    expect(liveState(vehicle({ flags: [{ flag_type: 'speeding', severity: 'high', observed_at: at(5) }] }), NOW)).toBe('speeding')
    expect(liveState(vehicle({ position: { ...vehicle().position!, speed_kmh: 0, stopped_since: at(400) } }), NOW)).toBe('idling')
    expect(liveState(vehicle({ position: null }), NOW)).toBe('no_signal')
    expect(['moving', 'stopped'].map((s) => needsAttention(s as never))).toEqual([false, false])
    expect(['speeding', 'offline', 'idling', 'no_signal'].every((s) => needsAttention(s as never))).toBe(true)
  })
})
