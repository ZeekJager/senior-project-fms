import { describe, expect, it } from 'vitest'
import { compareFit, rankDrivers, unsuitableReason } from './rankDrivers'
import type { AvailabilityResult, BoardDriver, BoardDistance, DriverTripRisk } from './types'

// The drivers for a trip, best fit first (docs/ml-trip-risk.md#ranking-on-the-console).

const free: AvailabilityResult = { availability: 'available', reasons: [] }
const warned = (code: string): AvailabilityResult => ({ availability: 'available_with_warning', reasons: [{ code, severity: 'warning' }] })

function driver(name: string, overrides: Partial<BoardDriver> = {}): BoardDriver {
  return {
    driver_id: name.toLowerCase().replaceAll(' ', '-'),
    full_name: name,
    license_categories: ['dry_cargo_2'],
    vehicle_types: ['truck', 'van'],
    state: 'idle',
    attendance: 'present',
    availability: free,
    current_trip: null,
    ...overrides,
  }
}
const risk = (late: number, safety: number): DriverTripRisk => ({ late_probability: late, safety_event_probability: safety, factors: { late: [], safety_event: [] } })
const left = (day: number, week: number): BoardDistance => ({
  trip_km: 100,
  day: { period: 'day', limit_km: 600, without_km: 0, with_km: 600 - day, left_km: day },
  week: { period: 'week', limit_km: 3000, without_km: 0, with_km: 3000 - week, left_km: week },
  over: null,
  near: null,
})
const names = (ranked: ReturnType<typeof rankDrivers>) => ranked.map((r) => `${r.rank ?? '-'} ${r.driver.full_name}${r.unsuitable ? ` (${r.unsuitable})` : ''}`)
const TRUCK = { vehicle_type: 'truck' }
const BUS = { vehicle_type: 'bus' }

describe('ranking the drivers for a trip', () => {
  it('ranks the suitable drivers by their chance of the trip going wrong, not by name', () => {
    const ranked = rankDrivers([driver('Abebe Kebede', { trip_risk: risk(0.3, 0.05) }), driver('Sara Haile', { trip_risk: risk(0.08, 0.02) }), driver('Dawit Bekele', { trip_risk: risk(0.15, 0.01) })], TRUCK)
    expect(names(ranked)).toEqual(['1 Sara Haile', '2 Dawit Bekele', '3 Abebe Kebede'])
  })

  it('with a vehicle chosen, a driver whose licence does not cover it is not suitable, however low their risk', () => {
    const ranked = rankDrivers([driver('Abebe Kebede', { trip_risk: risk(0.2, 0.05) }), driver('Sara Haile', { trip_risk: risk(0.01, 0.01), vehicle_types: ['car'] })], TRUCK)
    expect(names(ranked)).toEqual(['1 Abebe Kebede', '- Sara Haile (licence)'])
    expect(names(rankDrivers([driver('Abebe Kebede')], BUS))).toEqual(['- Abebe Kebede (licence)'])
  })

  it('without a vehicle, the licence is not judged yet', () => {
    expect(names(rankDrivers([driver('Sara Haile', { vehicle_types: ['car'] })], null))).toEqual(['1 Sara Haile'])
  })

  it('drivers on a trip, off today or blocked for the window come after the suitable ones, in the old order', () => {
    const ranked = rankDrivers(
      [
        driver('Zelalem On', { state: 'en_route' }),
        driver('Yonas Blocked', { state: 'unavailable', availability: { availability: 'unavailable', reasons: [{ code: 'driver_overlap', severity: 'block' }] } }),
        driver('Hana Absent', { state: 'absent', attendance: 'sick', availability: warned('driver_sick') }),
        driver('Abebe Kebede'),
      ],
      TRUCK,
    )
    expect(names(ranked)).toEqual(['1 Abebe Kebede', '- Hana Absent (absent)', '- Yonas Blocked (blocked)', '- Zelalem On (busy)'])
  })

  it('a blocking reason makes a driver unsuitable even in a free state', () => {
    expect(unsuitableReason(driver('A', { availability: { availability: 'unavailable', reasons: [{ code: 'license_expired', severity: 'block' }] } }), null)).toBe('blocked')
  })

  it('the same risk to the percentage point: fewer warnings, then free now, then more distance left, then the name', () => {
    const same = risk(0.104, 0.02)
    expect(compareFit(driver('B', { trip_risk: same }), driver('A', { trip_risk: risk(0.1, 0.021) }))).toBeGreaterThan(0)
    const ranked = rankDrivers(
      [
        driver('Warned', { trip_risk: same, availability: warned('distance_limit_near') }),
        driver('Finishing', { trip_risk: same, state: 'near_end' }),
        driver('Tired', { trip_risk: same, distance: left(80, 900) }),
        driver('Rested', { trip_risk: same, distance: left(400, 2000) }),
        driver('Bekele', { trip_risk: same }),
      ],
      TRUCK,
    )
    expect(names(ranked)).toEqual(['1 Bekele', '2 Rested', '3 Tired', '4 Finishing', '5 Warned'])
  })

  it('without the model, the drivers are still ranked by warnings, being free and distance left', () => {
    const ranked = rankDrivers([driver('Abebe', { availability: warned('driver_late') }), driver('Sara', { distance: left(50, 500) }), driver('Dawit', { state: 'near_end' })], TRUCK)
    expect(names(ranked)).toEqual(['1 Sara', '2 Dawit', '3 Abebe'])
  })
})
