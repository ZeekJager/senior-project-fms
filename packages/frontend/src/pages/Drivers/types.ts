// A driver as the API returns it (api-contract §6.3). Name, email, phone and
// home depot come from the driver's user account; the licence from
// fleet.drivers.

/** European licence categories, in the order a licence lists them. */
export const LICENSE_CATEGORIES = ['AM', 'A1', 'A2', 'A', 'B1', 'B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE'] as const
export type LicenseCategory = (typeof LICENSE_CATEGORIES)[number]

/** Grouped as the form shows them. */
export const LICENSE_CATEGORY_GROUPS: { label: string; categories: LicenseCategory[] }[] = [
  { label: 'Motorcycles', categories: ['AM', 'A1', 'A2', 'A'] },
  { label: 'Cars and vans', categories: ['B1', 'B', 'BE'] },
  { label: 'Trucks', categories: ['C1', 'C1E', 'C', 'CE'] },
  { label: 'Buses', categories: ['D1', 'D1E', 'D', 'DE'] },
]

/** Computed by the API from the expiry and today's date in Addis Ababa; expiring within 30 days. */
export type LicenseStatus = 'valid' | 'expiring_soon' | 'expired'

export interface DriverTrip {
  id: string
  status: 'assigned' | 'en_route'
  origin: string | null
  destination: string | null
  scheduled_start: string | null
}

export interface Driver {
  id: string
  user_id: string
  full_name: string
  email: string
  phone: string | null
  depot_id: string | null
  license_number: string
  license_categories: LicenseCategory[]
  /** YYYY-MM-DD */
  license_expiry: string
  license_status: LicenseStatus
  hire_date: string | null
  emergency_phone: string | null
  status: 'active' | 'retired'
  current_trip: DriverTrip | null
  version: number
  created_at: string
  updated_at: string
}
