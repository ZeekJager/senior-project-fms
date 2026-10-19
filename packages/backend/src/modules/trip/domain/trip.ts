import { AppError } from '../../../shared/errors/app-error';

export const TRIP_STATUSES = ['draft', 'scheduled', 'assigned', 'en_route', 'completed', 'cancelled'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

/** A planned stop, copied from the route when the trip is created or its route changes. */
export interface TripStopView {
  id: string;
  sequence_number: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  status: 'planned' | 'arrived' | 'completed' | 'skipped';
  planned_arrival: Date | null;
  actual_arrival: Date | null;
}

/** A trip as the API returns it (api-contract §16.2). Public ids only. */
export interface TripView {
  id: string;
  route_id: string | null;
  route_name: string | null;
  /** The route's depot: whose trip this is for depot scope. */
  depot_id: string | null;
  /** Null until the trip is assigned (FMS-31). */
  vehicle_id: string | null;
  driver_id: string | null;
  status: TripStatus;
  /** The plan as copied from the route; a later edit of the route does not change it. */
  origin: string | null;
  destination: string | null;
  planned_distance_km: number | null;
  planned_duration_seconds: number | null;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  actual_start: Date | null;
  actual_end: Date | null;
  actual_distance_km: number | null;
  stops: TripStopView[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Every trip event carries `trip_id`. Each change of a trip's status,
 * schedule, vehicle or driver publishes one of these in the change's
 * transaction: fleet's availability read model is kept from them
 * (fleet.trip-assignments, FMS-76). A write that skips them leaves it wrong
 * until the daily rebuild, which logs the drift.
 */
export const TRIP_EVENTS = {
  created: 'TripCreated',
  /** Rescheduled; changed_fields says which times. */
  updated: 'TripUpdated',
  cancelled: 'TripCancelled',
  /** A driver and vehicle were assigned (or changed) (FMS-31). */
  assigned: 'TripAssigned',
  /** The driver started the trip: en route (FMS-32). */
  started: 'TripStarted',
  /** The driver ended the trip (FMS-32). */
  completed: 'TripCompleted',
} as const;

/** States a trip can be assigned (or re-assigned) in. A draft needs its times first. */
export const ASSIGNABLE_STATUSES: readonly TripStatus[] = ['scheduled', 'assigned'];

/** States in which the plan (route, schedule) may still change, and from which a trip may be cancelled. */
export const OPEN_STATUSES: readonly TripStatus[] = ['draft', 'scheduled', 'assigned'];

export const tripNotFound = () => new AppError(404, 'NOT_FOUND', 'Trip not found.');

export const invalidDateRange = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_INVALID_DATE_RANGE', message, [{ field, reason: 'end_before_start' }]);

export const tripRouteNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The route does not exist or is outside your depots.', [
    { field: 'route_id', reason: 'references_missing_record' },
  ]);

export const tripRouteRetired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The route has been retired: choose an active route.', [{ field: 'route_id', reason: 'route_retired' }]);

export const tripClosed = (status: TripStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `A ${status.replace('_', ' ')} trip cannot be changed.`, [{ field: 'status', reason: `trip_${status}` }]);

export const cannotCancelEnRoute = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'A trip under way cannot be cancelled: end it instead.', [{ field: 'status', reason: 'trip_en_route' }]);

// Assignment (FMS-31). Each conflict names the record behind it in `record_id`.

/** BR-1: the driver is on another assigned or en-route trip that overlaps (touching ends included). */
export const driverOverlap = (tripId: string) =>
  new AppError(409, 'CONFLICT_DRIVER_OVERLAP', 'The driver is already on a trip at that time.', [{ field: 'driver_id', reason: 'overlapping_trip', record_id: tripId }]);

/** BR-3: the vehicle is on another assigned or en-route trip that overlaps (touching ends included). */
export const vehicleOverlap = (tripId: string) =>
  new AppError(409, 'CONFLICT_VEHICLE_OVERLAP', 'The vehicle is already on a trip at that time.', [{ field: 'vehicle_id', reason: 'overlapping_trip', record_id: tripId }]);

/** BR-2: the vehicle is flagged for maintenance (or in the workshop); record_id is its open maintenance record. */
export const vehicleFlagged = (maintenanceRecordId: string | null) =>
  new AppError(409, 'CONFLICT_VEHICLE_FLAGGED', 'The vehicle is flagged for maintenance and cannot be dispatched.', [
    { field: 'vehicle_id', reason: 'maintenance_flag', ...(maintenanceRecordId ? { record_id: maintenanceRecordId } : {}) },
  ]);

export const driverNotEligible = (reasons: readonly string[]) =>
  new AppError(409, 'CONFLICT_DRIVER_NOT_ELIGIBLE', 'The driver cannot drive this trip.', reasons.map((reason) => ({ field: 'driver_id', reason })));

export const vehicleNotActive = (status: string) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `A vehicle that is ${status} cannot be dispatched.`, [{ field: 'vehicle_id', reason: `vehicle_${status}` }]);

/** A trip is staffed from its own depot (FMS-76): the vehicle or driver belongs to another. */
export const depotMismatch = (field: 'driver_id' | 'vehicle_id') =>
  new AppError(409, 'CONFLICT_DEPOT_MISMATCH', `The ${field === 'driver_id' ? 'driver' : 'vehicle'} belongs to another depot than the trip.`, [
    { field, reason: 'other_depot' },
  ]);

export const assignmentRefNotFound = (field: 'driver_id' | 'vehicle_id') =>
  new AppError(400, 'VALIDATION_FAILED', `The ${field === 'driver_id' ? 'driver' : 'vehicle'} does not exist or is outside your depots.`, [
    { field, reason: 'references_missing_record' },
  ]);

export const notAssignable = (status: TripStatus) =>
  new AppError(
    409,
    'CONFLICT_INVALID_STATE_TRANSITION',
    status === 'draft' ? 'Schedule the trip before assigning it.' : `A ${status.replace('_', ' ')} trip cannot be assigned.`,
    [{ field: 'status', reason: `trip_${status}` }],
  );

/** Warnings on a successful assignment: they never block. */
export type AssignmentWarning =
  | {
      /** FMS-31 overrun rule: a trip of the driver or vehicle still under way runs into this one. */
      warning: 'PREVIOUS_TRIP_OVERRUN';
      field: 'driver_id' | 'vehicle_id';
      /** The trip still under way. */
      trip_id: string;
      /** When it is now expected to end: its scheduled end, or now if it is already late. */
      expected_end: string;
    }
  | {
      /** The driver is marked absent, on leave or sick on the trip's first day (FMS-21, via fleet availability). */
      warning: 'DRIVER_ATTENDANCE';
      field: 'driver_id';
      attendance: 'absent' | 'on_leave' | 'sick';
    };

/** A position in the history order: the trip's start (microseconds, UTC) and id. */
export interface TripCursor {
  at: string;
  id: string;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const NUMERIC = /^\d{1,19}$/;

export function encodeCursor(cursor: TripCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`).toString('base64url');
}

export function decodeCursor(token: string): TripCursor {
  const [at, id, extra] = Buffer.from(token, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !CURSOR_AT.test(at ?? '') || !NUMERIC.test(id ?? '')) throw invalidCursor();
  return { at, id };
}

export const invalidCursor = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The cursor is not valid. Start again from the first page.', [{ field: 'cursor', reason: 'invalid_cursor' }]);
