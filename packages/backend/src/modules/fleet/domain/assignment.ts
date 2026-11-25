import { AppError } from '../../../shared/errors/app-error';

/**
 * A driver's regular vehicle (FMS-77, docs/driver-vehicle-assignments.md), apart from trips: who normally drives which
 * vehicle, and who answers for its condition. fleet.driver_vehicle_assignments (migration 002).
 *
 * - `primary`: the driver's regular vehicle. A driver has at most one primary vehicle at a time, and a vehicle at most
 *   one primary driver: periods may not overlap (409 CONFLICT_DRIVER_IN_USE / CONFLICT_VEHICLE_IN_USE).
 * - `temporary`: a stand-in for a while (the regular vehicle in the workshop); it needs an end, and may overlap.
 */
export const ASSIGNMENT_TYPES = ['primary', 'temporary'] as const;
export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];

/** `active` until ended; `ended` once its end has passed by POST .../end. `cancelled` is the schema's, not used here. */
export type AssignmentStatus = 'active' | 'ended' | 'cancelled';

/** An assignment as the API returns it. Public ids only. */
export interface AssignmentView {
  id: string;
  driver: { id: string; full_name: string | null };
  vehicle: { id: string; registration_number: string };
  depot_id: string;
  assignment_type: AssignmentType;
  start_at: Date;
  end_at: Date | null;
  status: AssignmentStatus;
  /** Active and in force now: started, and not yet at its end. */
  current: boolean;
  notes: string | null;
  created_at: Date;
}

export const ASSIGNMENT_EVENTS = {
  /** A driver was given a vehicle, primary or temporary. */
  assigned: 'DriverVehicleAssigned',
  /** An assignment was ended. */
  ended: 'DriverVehicleAssignmentEnded',
} as const;

export const assignmentNotFound = () => new AppError(404, 'NOT_FOUND', 'Assignment not found.');

export const assignmentDriverNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The driver does not exist or is not in your depots.', [{ field: 'driver_id', reason: 'references_missing_record' }]);

export const assignmentVehicleNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle does not exist or is not in your depots.', [{ field: 'vehicle_id', reason: 'references_missing_record' }]);

export const assignmentDriverRetired = () =>
  new AppError(409, 'CONFLICT_DRIVER_NOT_ELIGIBLE', 'A retired driver cannot be given a vehicle.', [{ field: 'driver_id', reason: 'driver_retired' }]);

export const assignmentVehicleRetired = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'A retired vehicle cannot be given a driver.', [{ field: 'vehicle_id', reason: 'vehicle_retired' }]);

export const assignmentDepotMismatch = () =>
  new AppError(409, 'CONFLICT_DEPOT_MISMATCH', 'The driver and the vehicle belong to different depots.', [{ field: 'vehicle_id', reason: 'other_depot' }]);

export const driverHasPrimary = (assignmentId: string) =>
  new AppError(409, 'CONFLICT_DRIVER_IN_USE', 'The driver already has a primary vehicle for that time. End that assignment first.', [
    { field: 'driver_id', reason: 'driver_has_primary_vehicle', record_id: assignmentId },
  ]);

export const vehicleHasPrimary = (assignmentId: string) =>
  new AppError(409, 'CONFLICT_VEHICLE_IN_USE', 'The vehicle already has a primary driver for that time. End that assignment first.', [
    { field: 'vehicle_id', reason: 'vehicle_has_primary_driver', record_id: assignmentId },
  ]);

export const temporaryNeedsEnd = () =>
  new AppError(400, 'VALIDATION_FAILED', 'A temporary assignment needs an end.', [{ field: 'end_at', reason: 'required' }]);

export const assignmentDateRange = () =>
  new AppError(400, 'VALIDATION_INVALID_DATE_RANGE', 'The end must be after the start.', [{ field: 'end_at', reason: 'before_start' }]);

export const assignmentEndInFuture = () =>
  new AppError(400, 'VALIDATION_FAILED', 'An assignment is ended now or at a time already past.', [{ field: 'end_at', reason: 'in_future' }]);

export const assignmentAlreadyEnded = (status: AssignmentStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'The assignment has already ended.', [{ field: 'status', reason: status, allowed_transitions: [] }]);
