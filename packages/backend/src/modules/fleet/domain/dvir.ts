import { AppError } from '../../../shared/errors/app-error';

/** The inspection types fleet.dvir_reports accepts (chk_dvir_type). */
export const DVIR_TYPES = ['pre_trip', 'post_trip', 'routine', 'other'] as const;
export type DvirType = (typeof DVIR_TYPES)[number];

export type DvirStatus = 'submitted' | 'reviewed' | 'requires_action' | 'closed';

/** One line of the checklist: what was checked and whether it passed. */
export interface DvirItem {
  name: string;
  passed: boolean;
  notes: string | null;
}

/** A failed item, as a technician reads it. */
export interface DvirDefect {
  name: string;
  notes: string | null;
}

/** A DVIR as the API returns it (api-contract §6.4). Public ids only. */
export interface DvirReportView {
  id: string;
  vehicle_id: string;
  driver_id: string;
  trip_id: string | null;
  type: DvirType;
  status: DvirStatus;
  items: DvirItem[];
  /** The failed items. */
  defects: DvirDefect[];
  /** The driver's own answer, forced true by any failed item. */
  issues_found: boolean;
  /** When the driver submitted it: earlier than `created_at` if it came from the offline queue. */
  submitted_at: Date;
  created_at: Date;
}

export const DVIR_EVENTS = {
  /** A defect was reported: the vehicle now carries the maintenance flag. Alerts and technicians react to it. */
  faultDetected: 'VehicleFaultDetected',
} as const;

/** A DVIR is stamped with when the driver pressed submit; an offline queue may delay it, but not by more than this. */
export const MAX_SUBMISSION_AGE_DAYS = 30;
/** Phones' clocks drift: a submission this far ahead of the server is still believed. */
export const CLOCK_SKEW_MS = 5 * 60_000;

export const dvirVehicleNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle does not exist or is outside your depots.', [{ field: 'vehicle_id', reason: 'references_missing_record' }]);

export const dvirVehicleRetired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle has been retired: it cannot be inspected.', [{ field: 'vehicle_id', reason: 'vehicle_retired' }]);

export const dvirTripNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The trip does not exist or is not yours to see.', [{ field: 'trip_id', reason: 'references_missing_record' }]);

export const dvirTripVehicleMismatch = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The trip is assigned to a different vehicle.', [{ field: 'trip_id', reason: 'trip_vehicle_mismatch' }]);

export const dvirDriverNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The driver does not exist or is outside your depots.', [{ field: 'driver_id', reason: 'references_missing_record' }]);

/** Everyone but a driver must say whose inspection it is: the report belongs to a driver. */
export const dvirDriverRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Say which driver this inspection is for.', [{ field: 'driver_id', reason: 'required' }]);

export const dvirDriverNotWritable = () =>
  new AppError(400, 'VALIDATION_FAILED', 'A driver submits their own inspections: leave driver_id out.', [{ field: 'driver_id', reason: 'not_writable' }]);

export const dvirNoDriverProfile = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Your account has no driver profile, so it cannot submit inspections.', [{ field: 'driver_id', reason: 'no_driver_profile' }]);

export const dvirSubmittedInFuture = () =>
  new AppError(400, 'VALIDATION_FAILED', 'submitted_at cannot be in the future.', [{ field: 'submitted_at', reason: 'in_future' }]);

export const dvirSubmittedTooOld = () =>
  new AppError(400, 'VALIDATION_FAILED', `submitted_at cannot be more than ${MAX_SUBMISSION_AGE_DAYS} days ago.`, [{ field: 'submitted_at', reason: 'too_old' }]);
