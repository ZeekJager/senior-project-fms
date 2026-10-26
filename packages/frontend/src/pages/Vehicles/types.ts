// Shapes of the API's vehicle, depot and document resources (api-contract
// §6.1, §6.2, §8, §16.1). Public ids only.

export const VEHICLE_TYPES = ['car', 'suv', 'van', 'truck', 'bus', 'motorcycle', 'other'] as const
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'cng', 'lpg', 'other'] as const
export const VEHICLE_STATUSES = ['active', 'inactive', 'maintenance', 'retired'] as const

export type VehicleType = (typeof VEHICLE_TYPES)[number]
export type FuelType = (typeof FUEL_TYPES)[number]
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number]

export interface VehicleTrip {
  id: string
  status: 'assigned' | 'en_route'
  origin: string | null
  destination: string | null
  scheduled_start: string | null
}

export interface Vehicle {
  id: string
  registration_number: string
  vin: string | null
  make: string
  model: string
  year: number | null
  vehicle_type: VehicleType
  fuel_type: FuelType
  fuel_efficiency_ml_per_km: number | null
  status: VehicleStatus
  maintenance_flag: boolean
  health_score: number | null
  /** When the nightly scoring last set it (FMS-55); null when never scored. */
  health_score_updated_at: string | null
  depot_id: string
  odometer_km: number
  current_trip: VehicleTrip | null
  version: number
  created_at: string
  updated_at: string
}

export type { Depot } from '@/features/depots'

// Status and availability (api-contract §6.2, FMS-76).

export type Availability = 'available' | 'unavailable' | 'available_with_warning'

export interface AvailabilityReason {
  code: string
  severity: 'block' | 'warning'
  trip_id?: string
}

export interface VehicleAssignment {
  trip_id: string
  status: 'assigned' | 'en_route'
  start: string
  end: string
}

export interface VehicleStatusView {
  vehicle_id: string
  registration_number: string
  depot_id: string
  status: VehicleStatus
  maintenance: { flagged: boolean; in_workshop: boolean; open_record_id: string | null }
  availability: { availability: Availability; reasons: AvailabilityReason[]; window: { start: string; end: string } }
  current_assignment: VehicleAssignment | null
  next_assignment: VehicleAssignment | null
  last_status_change: {
    from_status: VehicleStatus
    to_status: VehicleStatus
    reason: string | null
    source: 'manual' | 'maintenance'
    maintenance_record_id: string | null
    changed_at: string
    changed_by: string | null
  } | null
  version: number
  updated_at: string
}

/** A trip already assigned to a vehicle taken off the road: the change went ahead, and the trip needs another vehicle. */
export interface StatusChangeWarning {
  warning: 'ASSIGNED_TRIP_AFFECTED'
  trip_id: string
  start: string
}

/** The statuses a person sets from the status panel; retiring goes through Decommission. */
export const SETTABLE_STATUSES = ['active', 'maintenance', 'inactive'] as const satisfies readonly VehicleStatus[]

/** What each status means for dispatch, in the panel's words. */
export const STATUS_MEANING: Record<VehicleStatus, { label: string; description: string }> = {
  active: { label: 'Active', description: 'In service and available for trips.' },
  maintenance: { label: 'In the workshop', description: 'Being serviced or repaired. Not dispatchable.' },
  inactive: { label: 'Out of service', description: 'Parked or awaiting a decision. Not dispatchable.' },
  retired: { label: 'Retired', description: 'Decommissioned. Kept for history.' },
}

/** Why a vehicle is not (or not quite) available. Unknown codes fall back to the code itself. */
export const AVAILABILITY_REASONS: Record<string, string> = {
  vehicle_retired: 'Retired',
  vehicle_in_maintenance: 'In the workshop',
  vehicle_out_of_service: 'Out of service',
  maintenance_flag: 'Flagged for maintenance: work on it is still open',
  vehicle_other_depot: 'Belongs to another depot',
  assigned_to_overlapping_trip: 'On another trip at that time',
}

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  car: 'Car',
  suv: 'SUV',
  van: 'Van',
  truck: 'Truck',
  bus: 'Bus',
  motorcycle: 'Motorcycle',
  other: 'Other',
}

export const FUEL_TYPE_LABELS: Record<FuelType, string> = {
  petrol: 'Petrol',
  diesel: 'Diesel',
  hybrid: 'Hybrid',
  electric: 'Electric',
  cng: 'CNG',
  lpg: 'LPG',
  other: 'Other',
}
