import { describe, expect, it } from 'vitest'
import { addisDayStart, extendTrack, focusedVehicle, plannedLine } from './focus'
import type { VehicleLocation, VehiclePosition } from './types'

const position = (recorded_at: string, lat = 9, lng = 38.7): VehiclePosition => ({
  lat,
  lng,
  speed_kmh: 30,
  heading: null,
  accuracy_m: null,
  ignition_on: true,
  recorded_at,
  stopped_since: null,
})

describe('one driver in focus (FMS-140)', () => {
  it('finds the vehicle the driver is on a trip in', () => {
    const on = { vehicle_id: 'v-1', trip: { driver: { driver_id: 'dr-1', full_name: 'Abebe Kebede' } } } as VehicleLocation
    const off = { vehicle_id: 'v-2', trip: null } as VehicleLocation
    expect(focusedVehicle([off, on], 'dr-1')).toBe(on)
    expect(focusedVehicle([off, on], 'dr-2')).toBeNull()
  })

  it('draws the route as planned through the stops that have a point, and nothing without a route', () => {
    const route = {
      origin: { latitude: 8.99, longitude: 38.79 },
      stops: [
        { name: 'Bishoftu', latitude: 8.75, longitude: 38.98 },
        { name: 'Mojo', latitude: null, longitude: null },
      ],
      destination: null,
    }
    expect(plannedLine(route)).toEqual([
      [8.99, 38.79],
      [8.75, 38.98],
    ])
    expect(plannedLine(undefined)).toEqual([])
  })

  it('today starts at midnight in Addis Ababa, whatever the browser zone', () => {
    expect(addisDayStart(new Date('2026-11-02T20:59:00Z'))).toBe('2026-11-01T21:00:00.000Z')
    expect(addisDayStart(new Date('2026-11-02T21:00:00Z'))).toBe('2026-11-02T21:00:00.000Z')
  })

  it('the track grows with each newer live position and ignores late or repeated ones', () => {
    const read = [{ recorded_at: '2026-11-02T06:00:00Z', lat: 9, lng: 38.7, speed_kmh: 20, trip_id: 't-1' }]
    const grown = extendTrack(read, position('2026-11-02T06:00:05Z', 9.001))
    expect(grown.map((p) => p.lat)).toEqual([9, 9.001])
    expect(extendTrack(grown, position('2026-11-02T06:00:05Z'))).toBe(grown)
    expect(extendTrack(grown, position('2026-11-02T05:59:00Z'))).toBe(grown)
    expect(extendTrack(grown, null)).toBe(grown)
  })
})
