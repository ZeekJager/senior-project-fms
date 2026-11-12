import type { ServiceDueSummary } from '@/features/service-due'
import type { TripEta } from '@/features/trip-eta'

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
  /** Copied from the route; under way, each has its arrival time (FMS-86). */
  stops?: TripStop[]
  /** Under way: the latest arrival estimate (FMS-86); null before the first, or not under way. */
  eta?: TripEta | null
  /** An assignment held for a fleet manager's approval (FMS-151) while it waits, or once refused; null otherwise. */
  exception?: AssignmentException | null
  /** What it carries (FMS-153): optional, never above the assigned vehicle's payload. */
  cargo_weight_kg?: number | null
  cargo_kind?: CargoKind
  /** What the job asks of its driver (FMS-153): worked out by the API, never typed. */
  job_load?: JobLoad
  /** Why, biggest first; empty for a light job with nothing to count. */
  job_load_reasons?: JobLoadReason[]
  version: number
}

/** What a trip carries (FMS-153). */
export type CargoKind = 'general' | 'fragile' | 'hazardous' | 'refrigerated' | 'passengers'

/** The job's load (FMS-153, docs/job-load.md). */
export type JobLoad = 'light' | 'standard' | 'heavy'

export type JobLoadReason = 'long_haul' | 'regional' | 'long_day' | 'long_hours' | 'many_stops' | 'night' | 'near_payload' | 'loaded'

/** An assignment held for approval (FMS-151): who and what was asked for, why, and what became of it. */
export interface AssignmentException {
  id: string
  trip_id: string
  status: 'pending' | 'approved' | 'refused' | 'withdrawn'
  driver_id: string
  vehicle_id: string
  warnings: AssignmentWarning[]
  reason: string
  requested_by: string | null
  requested_by_name: string | null
  requested_at: string
  decided_by: string | null
  decided_by_name: string | null
  decided_at: string | null
  decision_reason: string | null
}

export interface TripStop {
  id: string
  sequence_number: number
  name: string
  latitude: number | null
  longitude: number | null
  status: 'planned' | 'arrived' | 'completed' | 'skipped'
  /** When the vehicle came within 150 m of it. */
  actual_arrival: string | null
  /** Expected arrival; null once reached, without coordinates, or behind the vehicle. */
  eta: string | null
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
  /** The trip risk model's chances on the chosen trip (FMS-155): tracking:read, an active model, a driver free for it. */
  trip_risk?: DriverTripRisk | null
}

/** An input that raises a chance, with the value the model was given (docs/ml-trip-risk.md). */
export interface TripRiskFactor {
  feature: string
  value: number
}

/** One driver's predicted chances on one trip (FMS-155): advice for this trip, never a block or a ranking. */
export interface DriverTripRisk {
  late_probability: number
  safety_event_probability: number
  factors: { late: TripRiskFactor[]; safety_event: TripRiskFactor[] }
}

/** Whether the board carries the model's chances, and why not. */
export interface BoardTripRisk {
  status: 'ok' | 'not_enough_trips' | 'off' | 'unavailable'
  reason: string | null
  model_version: string | null
  /** Trained on generated trips, not this fleet's. */
  demonstration: boolean
  trips: number
  drivers: number
  minimum: { trips: number; drivers: number }
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
  /** Preventive service due or overdue (FMS-129): a warning, never a block. */
  service_due: ServiceDueSummary | null
  current_trip: { trip_id: string; end: string } | null
}

export interface DispatchBoard {
  depot_id: string
  window: { start: string; end: string }
  /** With a chosen trip and tracking:read (FMS-155); null or absent otherwise. */
  trip_risk?: BoardTripRisk | null
  drivers: BoardDriver[]
  vehicles: BoardVehicle[]
}

export type AssignmentWarning =
  | { warning: 'PREVIOUS_TRIP_OVERRUN'; field: 'driver_id' | 'vehicle_id'; trip_id: string; expected_end: string }
  | { warning: 'DRIVER_ATTENDANCE'; field: 'driver_id'; attendance: 'absent' | 'on_leave' | 'sick' }
