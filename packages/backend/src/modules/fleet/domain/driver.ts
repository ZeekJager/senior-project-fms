import { AppError } from '../../../shared/errors/app-error';
import type { VehicleType } from './vehicle';

/**
 * European driving licence categories (EU Directive 2006/126/EC), in the
 * order a licence lists them, and which of our vehicle types each allows.
 * A driver holds several (fleet.drivers.license_categories, e.g. B and CE);
 * a vehicle is allowed if any of them allows it.
 *
 * vehicle_type is coarser than the categories: it does not tell a 7.5 t truck
 * (C1) from a 40 t one (C), or a minibus (D1) from a coach (D), so each of
 * those allows the whole type. `other` (special machinery) has no EU
 * category; B1 (quadricycles) is the closest. Change this one table if the
 * client's rules differ.
 */
export const LICENSE_CATEGORY_VEHICLE_TYPES = {
  AM: ['motorcycle'],
  A1: ['motorcycle'],
  A2: ['motorcycle'],
  A: ['motorcycle'],
  B1: ['other'],
  B: ['car', 'suv', 'van'],
  BE: ['car', 'suv', 'van'],
  C1: ['truck'],
  C1E: ['truck'],
  C: ['truck'],
  CE: ['truck'],
  D1: ['bus'],
  D1E: ['bus'],
  D: ['bus'],
  DE: ['bus'],
} as const satisfies Record<string, readonly VehicleType[]>;

export type LicenseCategory = keyof typeof LICENSE_CATEGORY_VEHICLE_TYPES;
export const LICENSE_CATEGORIES = Object.keys(LICENSE_CATEGORY_VEHICLE_TYPES) as [LicenseCategory, ...LicenseCategory[]];

/** Whether any of a driver's categories allows driving a vehicle type. */
export function categoryAllows(categories: readonly string[], vehicleType: VehicleType): boolean {
  return categories.some((c) => {
    const allowed: readonly string[] | undefined = LICENSE_CATEGORY_VEHICLE_TYPES[c as LicenseCategory];
    return allowed?.includes(vehicleType) ?? false;
  });
}

/** Categories without duplicates, in the order a licence lists them (AM ... DE). */
export function normalizeCategories(categories: readonly LicenseCategory[]): LicenseCategory[] {
  return LICENSE_CATEGORIES.filter((c) => categories.includes(c));
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
  /** European categories held, in licence order; empty when not recorded. */
  license_categories: LicenseCategory[];
  /** `YYYY-MM-DD`. */
  license_expiry: string;
  /** From the expiry and today's date in Addis Ababa; `expiring_soon` within EXPIRING_SOON_DAYS. */
  license_status: LicenseStatus;
  hire_date: string | null;
  emergency_phone: string | null;
  status: 'active' | 'retired';
  /** Bumped on every change, a depot move included; also the ETag. Send it back in `If-Match` to refuse a stale PATCH. */
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Event types this module publishes for drivers (CONVENTIONS.md, Events). */
export const DRIVER_EVENTS = {
  registered: 'DriverRegistered',
  updated: 'DriverUpdated',
  transferred: 'DriverTransferred',
  retired: 'DriverRetired',
  reinstated: 'DriverReinstated',
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
