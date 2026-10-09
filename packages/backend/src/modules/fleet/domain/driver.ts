import { AppError } from '../../../shared/errors/app-error';
import type { VehicleType } from './vehicle';

/**
 * Ethiopian driving licence classes, as stored in fleet.drivers.license_category.
 * ASSUMPTION to confirm with the client: the classes and which of our vehicle
 * types each allows (vehicle_type does not tell a light from a heavy truck, so
 * every cargo class allows `truck`). Change this one table if they differ.
 */
export const LICENSE_CATEGORY_VEHICLE_TYPES = {
  motorcycle: ['motorcycle'],
  automobile: ['car', 'suv'],
  public_1: ['car', 'suv', 'van'],
  public_2: ['car', 'suv', 'van', 'bus'],
  public_3: ['car', 'suv', 'van', 'bus'],
  dry_cargo_1: ['car', 'suv', 'van', 'truck'],
  dry_cargo_2: ['car', 'suv', 'van', 'truck'],
  dry_cargo_3: ['car', 'suv', 'van', 'truck'],
  liquid_cargo_1: ['car', 'suv', 'van', 'truck'],
  liquid_cargo_2: ['car', 'suv', 'van', 'truck'],
  special: ['other'],
} as const satisfies Record<string, readonly VehicleType[]>;

export type LicenseCategory = keyof typeof LICENSE_CATEGORY_VEHICLE_TYPES;
export const LICENSE_CATEGORIES = Object.keys(LICENSE_CATEGORY_VEHICLE_TYPES) as [LicenseCategory, ...LicenseCategory[]];

/** Whether a licence class allows driving a vehicle type. */
export function categoryAllows(category: string, vehicleType: VehicleType): boolean {
  const allowed: readonly string[] | undefined = LICENSE_CATEGORY_VEHICLE_TYPES[category as LicenseCategory];
  return allowed?.includes(vehicleType) ?? false;
}

/** A licence within this many days of expiry is `expiring_soon`. */
export const EXPIRING_SOON_DAYS = 30;

/** Days before expiry on which DriverLicenseExpiring is published. */
export const EXPIRY_WARNING_DAYS = [30, 7] as const;

export type LicenseStatus = 'valid' | 'expiring_soon' | 'expired';
export const LICENSE_STATUSES: [LicenseStatus, ...LicenseStatus[]] = ['valid', 'expiring_soon', 'expired'];

/** Why a driver may not be dispatched (several can apply at once). */
export type EligibilityReason =
  | 'driver_not_found'
  | 'driver_retired'
  | 'account_not_active'
  | 'license_expired'
  | 'license_category_missing'
  | 'license_category_not_valid_for_vehicle'
  | 'vehicle_not_found';

export interface DriverEligibility {
  eligible: boolean;
  reasons: EligibilityReason[];
}

/**
 * A driver as the API returns it. Public ids only. Name, email, phone and the
 * home depot come from the driver's user account; licence data and the
 * emergency contact from fleet.drivers. Licence and phone are personal data,
 * so every driver endpoint needs `driver:read` or more.
 */
export interface DriverView {
  id: string;
  user_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  depot_id: string | null;
  license_number: string;
  license_category: LicenseCategory | null;
  /** `YYYY-MM-DD`. */
  license_expiry: string;
  /** From the expiry and today's date in Addis Ababa; `expiring_soon` within EXPIRING_SOON_DAYS. */
  license_status: LicenseStatus;
  hire_date: string | null;
  emergency_phone: string | null;
  status: 'active' | 'retired';
  created_at: Date;
  updated_at: Date;
}

/** Event types this module publishes for drivers (CONVENTIONS.md, Events). */
export const DRIVER_EVENTS = {
  registered: 'DriverRegistered',
  retired: 'DriverRetired',
  licenseExpiring: 'DriverLicenseExpiring',
} as const;

/**
 * Licence dates are calendar dates in Ethiopia, so "valid on" a moment means
 * on that moment's date in Addis Ababa, not in UTC: a trip at 01:00 on
 * 1 January local time needs a licence valid on 1 January.
 */
export const OPERATING_TIME_ZONE = 'Africa/Addis_Ababa';

/** Licence numbers are stored trimmed, upper case, single-spaced, so the unique constraint catches case variants. */
export function normalizeLicense(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

export const driverNotFound = () => new AppError(404, 'NOT_FOUND', 'Driver not found.');

export const driverInUse = () =>
  new AppError(409, 'CONFLICT_DRIVER_IN_USE', 'The driver is on an active trip or assigned to a vehicle. End that first.');

export const driverRetired = () => new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'A retired driver cannot be changed.');

/** The account in `user_id` does not exist, is outside the caller's depots, is not active, or lacks the driver role. */
export const unknownDriverAccount = (reason: 'references_missing_record' | 'account_not_active' | 'not_a_driver') =>
  new AppError(400, 'VALIDATION_FAILED', 'The user account cannot be registered as a driver.', [{ field: 'user_id', reason }]);

export const driverDepotNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The depot does not exist.', [{ field: 'depot_id', reason: 'references_missing_record' }]);
