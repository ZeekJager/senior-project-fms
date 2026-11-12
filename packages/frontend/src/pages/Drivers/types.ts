// A driver as the API returns it (api-contract §6.3). Name, email, phone and
// home depot come from the driver's user account; the licence from
// fleet.drivers.

// Ethiopian licence classes (docs/driving-licences.md): shared with the dispatch console.
import type { LicenseCategory } from '@/lib/licence'
export { LICENSE_CATEGORIES, LICENSE_CATEGORY_GROUPS, type LicenseCategory } from '@/lib/licence'

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
  /** The photo (docs/photos.md), or null: a placeholder is shown. */
  photo_url?: string | null
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
  /** Today's attendance, or null if not recorded yet (FMS-21). */
  attendance_today: 'present' | 'absent' | 'on_leave' | 'late' | 'sick' | 'other' | null
  version: number
  created_at: string
  updated_at: string
}
