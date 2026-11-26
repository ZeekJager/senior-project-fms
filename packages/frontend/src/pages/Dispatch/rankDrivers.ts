import type { BoardDriver, BoardVehicle, DriverState } from './types'

// The drivers for a trip, best fit first (docs/ml-trip-risk.md#ranking-on-the-console): the ones who can take it, with
// the chosen vehicle if there is one, ranked; then everyone else, as before (state, then name). Every driver stays
// selectable: the API is the last word on an assignment, and a ranked list is advice.

/** The order of the drivers who cannot take the trip: the old one. */
const OTHER_ORDER: DriverState[] = ['idle', 'near_end', 'absent', 'unavailable', 'en_route']

/** Why a driver is not among the suitable ones. Null: suitable. */
export type UnsuitableReason = 'busy' | 'absent' | 'blocked' | 'licence'

export interface RankedDriver {
  driver: BoardDriver
  /** 1 for the best fit; null for a driver who is not suitable. */
  rank: number | null
  unsuitable: UnsuitableReason | null
}

/** Why the driver cannot take the trip (with the vehicle, when one is chosen), or null when they can. */
export function unsuitableReason(d: BoardDriver, vehicle: Pick<BoardVehicle, 'vehicle_type'> | null): UnsuitableReason | null {
  if (d.availability.availability === 'unavailable' || d.state === 'unavailable') return 'blocked'
  if (d.state === 'en_route') return 'busy'
  if (d.state === 'absent') return 'absent'
  if (vehicle && !d.vehicle_types.includes(vehicle.vehicle_type)) return 'licence'
  return null
}

/** The chance of the trip going wrong with this driver: late or a safety event, in whole percentage points. */
const riskPoints = (d: BoardDriver) => (d.trip_risk ? Math.round((d.trip_risk.late_probability + d.trip_risk.safety_event_probability) * 100) : 0)
const warnings = (d: BoardDriver) => d.availability.reasons.filter((r) => r.severity === 'warning').length
/** The load-weighted km left in the tighter of the driver's day and week with the trip (FMS-156); none known: no limit felt. */
const kmLeft = (d: BoardDriver) => (d.distance ? Math.min(d.distance.day.left_km, d.distance.week.left_km) : Number.POSITIVE_INFINITY)

/**
 * Best fit first, among the drivers who can take the trip:
 * 1. the lower chance of it running late or of a safety event (the trip risk model, FMS-155), to the percentage point;
 * 2. fewer warnings (attendance, near a distance limit);
 * 3. free now before finishing a trip;
 * 4. more distance left before a limit;
 * 5. the name.
 * Without the model's chances, the ranking starts at 2.
 */
export function compareFit(a: BoardDriver, b: BoardDriver): number {
  return (
    riskPoints(a) - riskPoints(b) ||
    warnings(a) - warnings(b) ||
    Number(a.state === 'near_end') - Number(b.state === 'near_end') ||
    kmLeft(b) - kmLeft(a) ||
    a.full_name.localeCompare(b.full_name)
  )
}

/** The suitable drivers ranked best fit first, then the others in their old order (state, then name). */
export function rankDrivers(drivers: readonly BoardDriver[], vehicle: Pick<BoardVehicle, 'vehicle_type'> | null): RankedDriver[] {
  const withReason = drivers.map((driver) => ({ driver, unsuitable: unsuitableReason(driver, vehicle) }))
  const suitable = withReason
    .filter((d) => d.unsuitable === null)
    .sort((a, b) => compareFit(a.driver, b.driver))
    .map((d, i) => ({ ...d, rank: i + 1 }))
  const others = withReason
    .filter((d) => d.unsuitable !== null)
    .sort((a, b) => OTHER_ORDER.indexOf(a.driver.state) - OTHER_ORDER.indexOf(b.driver.state) || a.driver.full_name.localeCompare(b.driver.full_name))
    .map((d) => ({ ...d, rank: null }))
  return [...suitable, ...others]
}

export const UNSUITABLE_TEXT: Record<UnsuitableReason, string> = {
  blocked: 'Cannot take this trip',
  busy: 'On a trip',
  absent: 'Not at work today',
  licence: 'Licence does not cover this vehicle',
}
