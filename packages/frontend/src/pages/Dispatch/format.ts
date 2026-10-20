import type { BadgeTone } from '@/components/ui'
import type { BoardDriver, DriverState, Trip, VehicleState } from './types'

// Dispatch reads times in Addis Ababa, 24-hour clock.
const TZ = 'Africa/Addis_Ababa'
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })

export const formatTime = (iso: string) => timeFmt.format(new Date(iso))
export const formatDay = (iso: string) => dayFmt.format(new Date(iso))

/** "Mon 2 Nov · 09:00–12:00", or across days "Mon 2 Nov 22:00 – Tue 3 Nov 04:00". */
export function formatWindow(start: string | null, end: string | null): string {
  if (!start || !end) return 'Not scheduled'
  return formatDay(start) === formatDay(end)
    ? `${formatDay(start)} · ${formatTime(start)}–${formatTime(end)}`
    : `${formatDay(start)} ${formatTime(start)} – ${formatDay(end)} ${formatTime(end)}`
}

/** "Addis Ababa → Adama", with whichever ends are known. */
export function tripEnds(trip: Pick<Trip, 'origin' | 'destination'>): string | null {
  if (!trip.origin && !trip.destination) return null
  return `${trip.origin ?? 'Origin not set'} → ${trip.destination ?? 'Destination not set'}`
}

export const tripTitle = (trip: Trip) => trip.route_name ?? tripEnds(trip) ?? 'Trip'

interface StateLook {
  label: string
  tone: BadgeTone
  /** Shown on hover and read out: what the colour means. */
  hint: string
}

const ATTENDANCE_LABEL: Record<string, string> = { absent: 'Absent today', on_leave: 'On leave today', sick: 'Sick today' }

/** green available · amber finishing a trip · red on a trip · grey absent (the card's colours, FMS-33). */
export function driverLook(d: Pick<BoardDriver, 'state' | 'attendance'>): StateLook {
  const looks: Record<DriverState, StateLook> = {
    idle: { label: 'Available', tone: 'success', hint: 'Present and free' },
    near_end: { label: 'Finishing a trip', tone: 'warning', hint: 'On a trip that ends within 30 minutes' },
    en_route: { label: 'On a trip', tone: 'danger', hint: 'On a trip under way' },
    absent: { label: ATTENDANCE_LABEL[d.attendance ?? 'absent'] ?? 'Absent today', tone: 'neutral', hint: ATTENDANCE_LABEL[d.attendance ?? 'absent'] ?? 'Absent today' },
    unavailable: { label: 'Not free then', tone: 'danger', hint: 'Cannot take this trip' },
  }
  return looks[d.state]
}

/** green available · red flagged · grey on a trip (FMS-33). */
export function vehicleLook(state: VehicleState): StateLook {
  const looks: Record<VehicleState, StateLook> = {
    idle: { label: 'Available', tone: 'success', hint: 'Free and roadworthy' },
    flagged: { label: 'Flagged', tone: 'danger', hint: 'Flagged for maintenance or in the workshop' },
    en_route: { label: 'On a trip', tone: 'neutral', hint: 'On a trip under way' },
    unavailable: { label: 'Not free then', tone: 'warning', hint: 'Cannot take this trip' },
  }
  return looks[state]
}

/** Why a driver or vehicle cannot (or should not) take the trip. Unknown codes fall back to the code. */
export const REASONS: Record<string, string> = {
  assigned_to_overlapping_trip: 'On another trip at that time',
  maintenance_flag: 'Flagged for maintenance',
  vehicle_in_maintenance: 'In the workshop',
  vehicle_out_of_service: 'Out of service',
  vehicle_retired: 'Retired',
  vehicle_other_depot: 'Belongs to another depot',
  driver_other_depot: 'Belongs to another depot',
  driver_retired: 'Retired',
  account_not_active: 'Account not active',
  license_expired: 'Licence expired',
  driver_absent: 'Marked absent that day',
  driver_on_leave: 'On leave that day',
  driver_sick: 'Off sick that day',
  license_category_missing: 'No licence class on file',
  license_category_not_valid_for_vehicle: 'Licence class does not cover this vehicle',
}

export const reasonText = (code: string) => REASONS[code] ?? code.replaceAll('_', ' ')

export const VEHICLE_TYPE_LABELS: Record<string, string> = { car: 'Car', suv: 'SUV', van: 'Van', truck: 'Truck', bus: 'Bus', motorcycle: 'Motorcycle', other: 'Other' }
