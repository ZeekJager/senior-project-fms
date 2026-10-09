// Shapes of the API's vehicle, depot and document resources (api-contract
// §6.1, §6.2, §8, §16.1). Public ids only.

export const VEHICLE_TYPES = ['car', 'suv', 'van', 'truck', 'bus', 'motorcycle', 'other'] as const
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'cng', 'lpg', 'other'] as const
export const VEHICLE_STATUSES = ['active', 'inactive', 'maintenance', 'retired', 'decommissioned'] as const

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
  depot_id: string
  odometer_km: number
  current_trip: VehicleTrip | null
  version: number
  created_at: string
  updated_at: string
}

export type { Depot } from '@/features/depots'

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
