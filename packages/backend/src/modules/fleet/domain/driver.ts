import { AppError } from '../../../shared/errors/app-error';

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
  license_category: string | null;
  /** `YYYY-MM-DD`. */
  license_expiry: string;
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
