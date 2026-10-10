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

export interface Depot {
  id: string
  name: string
  code: string | null
  location: string
}

export const DOCUMENT_TYPES = [
  'registration',
  'licence',
  'insurance',
  'maintenance_invoice',
  'inspection_evidence',
  'incident_photo',
  'dvir_attachment',
  'fuel_receipt',
  'other',
] as const

export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export interface VehicleDocument {
  id: string
  owner_type: 'vehicle' | 'driver'
  owner_id: string
  document_type: DocumentType
  original_filename: string | null
  content_type: 'image/jpeg' | 'image/png' | 'application/pdf'
  size_bytes: number
  sha256: string
  expires_on: string | null
  retain_until: string | null
  uploaded_by: string
  uploaded_at: string
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

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  registration: 'Registration',
  licence: 'Licence',
  insurance: 'Insurance',
  maintenance_invoice: 'Maintenance invoice',
  inspection_evidence: 'Inspection evidence',
  incident_photo: 'Incident photo',
  dvir_attachment: 'DVIR attachment',
  fuel_receipt: 'Fuel receipt',
  other: 'Other',
}
