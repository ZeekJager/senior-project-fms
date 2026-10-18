import { AppError } from '../../../shared/errors/app-error';
import type { AttendanceStatus } from './attendance';
import type { VehicleStatus } from './vehicle';

/**
 * Vehicle status and availability (FMS-76): the one answer to "is this
 * vehicle or driver free between A and B", for the dispatcher console
 * (FMS-33) and the assignment rules (FMS-31) alike.
 */

/** Lowercase, as every enum in the API (api-contract §3.5). */
export type Availability = 'available' | 'unavailable' | 'available_with_warning';

export type AvailabilityReasonCode =
  // Vehicles
  | 'vehicle_retired'
  | 'vehicle_in_maintenance'
  | 'vehicle_out_of_service'
  | 'maintenance_flag'
  // Drivers
  | 'driver_retired'
  | 'account_not_active'
  | 'license_expired'
  | 'driver_absent'
  | 'driver_on_leave'
  | 'driver_sick'
  // Both
  | 'assigned_to_overlapping_trip';

export interface AvailabilityReason {
  code: AvailabilityReasonCode;
  /** block: unavailable. warning: available, but the dispatcher should know. */
  severity: 'block' | 'warning';
  /** The overlapping trip (public id), for assigned_to_overlapping_trip. */
  trip_id?: string;
}

export interface AvailabilityResult {
  availability: Availability;
  /** Every reason that applies, blocks first; empty when available. */
  reasons: AvailabilityReason[];
}

/** A time window, both ends included: a 0-minute gap between trips is an overlap. */
export interface AvailabilityWindow {
  start: Date;
  end: Date;
}

/** The longest window one question may cover. */
export const MAX_WINDOW_DAYS = 31;

export interface VehicleFacts {
  status: VehicleStatus;
  maintenanceFlag: boolean;
  /** Public ids of assigned or en-route trips whose window touches the one asked about. */
  overlappingTrips: string[];
}

export interface DriverFacts {
  isActive: boolean;
  accountStatus: string;
  /** The licence is valid on the window's first day (Addis Ababa). */
  licenseValid: boolean;
  /** Attendance on the window's first day, if recorded. */
  attendance: AttendanceStatus | null;
  overlappingTrips: string[];
}

const block = (code: AvailabilityReasonCode, tripId?: string): AvailabilityReason => ({ code, severity: 'block', ...(tripId ? { trip_id: tripId } : {}) });
const warn = (code: AvailabilityReasonCode): AvailabilityReason => ({ code, severity: 'warning' });

function result(reasons: AvailabilityReason[]): AvailabilityResult {
  if (reasons.some((r) => r.severity === 'block')) return { availability: 'unavailable', reasons: [...reasons].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1)) };
  return { availability: reasons.length > 0 ? 'available_with_warning' : 'available', reasons };
}

/**
 * A vehicle is available when it is active, not flagged for maintenance and
 * not on another assigned or en-route trip in the window.
 */
export function vehicleAvailability(f: VehicleFacts): AvailabilityResult {
  const reasons: AvailabilityReason[] = [];
  if (f.status === 'retired' || f.status === 'decommissioned') reasons.push(block('vehicle_retired'));
  else if (f.status === 'maintenance') reasons.push(block('vehicle_in_maintenance'));
  else if (f.status === 'inactive') reasons.push(block('vehicle_out_of_service'));
  if (f.maintenanceFlag) reasons.push(block('maintenance_flag'));
  for (const trip of f.overlappingTrips) reasons.push(block('assigned_to_overlapping_trip', trip));
  return result(reasons);
}

/** Attendance that does not block but must be shown (api-contract §6.3: a warning in dispatch, not a block). */
const ATTENDANCE_WARNINGS: Partial<Record<AttendanceStatus, AvailabilityReasonCode>> = {
  absent: 'driver_absent',
  on_leave: 'driver_on_leave',
  sick: 'driver_sick',
};

/**
 * A driver is available when not retired, their account is active, their
 * licence is valid and they are on no other trip in the window. Being marked
 * absent, on leave or sick that day is a warning, not a block.
 */
export function driverAvailability(f: DriverFacts): AvailabilityResult {
  const reasons: AvailabilityReason[] = [];
  if (!f.isActive) reasons.push(block('driver_retired'));
  if (f.accountStatus !== 'active') reasons.push(block('account_not_active'));
  if (!f.licenseValid) reasons.push(block('license_expired'));
  for (const trip of f.overlappingTrips) reasons.push(block('assigned_to_overlapping_trip', trip));
  const attendance = f.attendance ? ATTENDANCE_WARNINGS[f.attendance] : undefined;
  if (attendance) reasons.push(warn(attendance));
  return result(reasons);
}

// ---------------------------------------------------------------------------
// Status transitions

/** Statuses a vehicle can be moved between with POST /vehicles/{id}/status. Retired is final. */
export const SETTABLE_STATUSES = ['active', 'maintenance', 'inactive', 'retired'] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

/**
 * Allowed moves. active, maintenance and inactive (out of service) move
 * freely between each other and to retired; nothing leaves retired (or the
 * legacy decommissioned).
 */
export const STATUS_TRANSITIONS: Record<VehicleStatus, readonly VehicleStatus[]> = {
  active: ['maintenance', 'inactive', 'retired'],
  maintenance: ['active', 'inactive', 'retired'],
  inactive: ['active', 'maintenance', 'retired'],
  retired: [],
  decommissioned: [],
};

export function canTransition(from: VehicleStatus, to: VehicleStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export const invalidStatusTransition = (from: VehicleStatus, to: VehicleStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `A ${from} vehicle cannot become ${to}.`, [{ field: 'status', reason: `${from}_to_${to}` }]);

/** A vehicle out on a trip cannot be taken off the road under it: end the trip first. */
export const vehicleUnderWay = (tripId: string) =>
  new AppError(409, 'CONFLICT_VEHICLE_IN_USE', 'The vehicle is on a trip under way: end the trip first.', [{ field: 'status', reason: 'trip_en_route', record_id: tripId }]);

/** GET /vehicles/{id}/status (api-contract §6.2): status, maintenance, availability for a window, assignments, last change. */
export interface VehicleStatusView {
  vehicle_id: string;
  registration_number: string;
  depot_id: string;
  status: VehicleStatus;
  maintenance: {
    /** maintenance_flag: open work from the maintenance module. */
    flagged: boolean;
    /** status is `maintenance`: in the workshop. */
    in_workshop: boolean;
    /** The open maintenance record behind the flag, if any. */
    open_record_id: string | null;
  };
  availability: AvailabilityResult & { window: { start: Date; end: Date } };
  /** The trip under way, or the assigned one covering now. */
  current_assignment: AssignmentView | null;
  /** The next assigned trip after now. */
  next_assignment: AssignmentView | null;
  last_status_change: { from_status: VehicleStatus; to_status: VehicleStatus; reason: string | null; changed_at: Date; changed_by: string | null } | null;
  version: number;
  updated_at: Date;
}

export interface AssignmentView {
  trip_id: string;
  status: 'assigned' | 'en_route';
  start: Date;
  end: Date;
}

/** Trips already assigned to a vehicle taken off the road: the change goes ahead, and the dispatcher is told which to re-assign. */
export interface StatusChangeWarning {
  warning: 'ASSIGNED_TRIP_AFFECTED';
  trip_id: string;
  start: Date;
}

export const invalidWindow = (message: string) => new AppError(400, 'VALIDATION_INVALID_DATE_RANGE', message, [{ field: 'to', reason: 'invalid_window' }]);
