// Shapes of the trip (api-contract §7.2) and dispatch board (FMS-33)
// resources the console reads. Public ids only.

export type TripStatus = 'draft' | 'scheduled' | 'assigned' | 'en_route' | 'completed' | 'cancelled'

export interface Trip {
  id: string
  route_id: string | null
  route_name: string | null
  depot_id: string | null
  vehicle_id: string | null
  driver_id: string | null
  status: TripStatus
  origin: string | null
  destination: string | null
  planned_distance_km: number | null
  scheduled_start: string | null
  scheduled_end: string | null
  /** Set when the driver starts the trip: an en-route trip keeps its start (FMS-139). */
  actual_start: string | null
  version: number
}

/** A trip moved later to make room for a change (PATCH /trips/{id} meta.shifted, FMS-139). */
export interface ShiftedTrip {
  trip_id: string
  scheduled_start: string
  scheduled_end: string
}

export type Availability = 'available' | 'unavailable' | 'available_with_warning'

export interface AvailabilityReason {
  code: string
  severity: 'block' | 'warning'
  trip_id?: string
}

export interface AvailabilityResult {
  availability: Availability
  reasons: AvailabilityReason[]
}

/** green idle · amber near_end · red en_route · grey absent; unavailable: blocked for the trip's window. */
export type DriverState = 'idle' | 'near_end' | 'en_route' | 'absent' | 'unavailable'
/** green idle · red flagged · grey en_route; unavailable: blocked for the trip's window. */
export type VehicleState = 'idle' | 'flagged' | 'en_route' | 'unavailable'

export interface BoardDriver {
  driver_id: string
  full_name: string
  license_categories: string[]
  vehicle_types: string[]
  state: DriverState
  attendance: 'present' | 'absent' | 'late' | 'on_leave' | 'sick' | 'other' | null
  availability: AvailabilityResult
  current_trip: { trip_id: string; end: string } | null
}

export interface OpenWork {
  id: string
  description: string
  status: string
  priority: string
  opened_at: string
}

export interface BoardVehicle {
  vehicle_id: string
  registration_number: string
  make: string
  model: string
  vehicle_type: string
  status: string
  state: VehicleState
  availability: AvailabilityResult
  open_work: OpenWork | null
  current_trip: { trip_id: string; end: string } | null
}

export interface DispatchBoard {
  depot_id: string
  window: { start: string; end: string }
  drivers: BoardDriver[]
  vehicles: BoardVehicle[]
}

export type AssignmentWarning =
  | { warning: 'PREVIOUS_TRIP_OVERRUN'; field: 'driver_id' | 'vehicle_id'; trip_id: string; expected_end: string }
  | { warning: 'DRIVER_ATTENDANCE'; field: 'driver_id'; attendance: 'absent' | 'on_leave' | 'sick' }
