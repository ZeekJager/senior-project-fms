import { AppError } from '../../../shared/errors/app-error';
import type { AssignmentExceptionView } from './exception';

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
  /** Expected arrival from the vehicle's latest position (FMS-86); null once reached, without coordinates, or not under way. */
  eta: Date | null;
  /** When it was marked done (FMS-95), by the driver or dispatch; reaching it by GPS makes it `arrived` only. */
  completed_at: Date | null;
}

/** A trip under way's latest arrival estimate (FMS-86, docs/eta.md): from its newest position, at most every 30 s. */
export interface TripEta {
  /** At the destination; null when the route has no destination coordinates. */
  arrival_at: Date | null;
  /** Along the road from the position, through the stops ahead, to the destination (or the last stop without one). */
  remaining_km: number | null;
  remaining_seconds: number | null;
  /** The next stop ahead that has an estimate, if any. */
  next_stop: { stop_id: string; name: string; eta: Date } | null;
  /** The position the estimate is from, and when it was worked out. */
  position_at: Date;
  updated_at: Date;
}

/** A trip as the API returns it (api-contract §16.2). Public ids only. */
/**
 * A trip as a live board needs it (FMS-43, `trip.updated`): public ids, status
 * and times, nothing about people beyond ids.
 */
export interface TripSummary {
  trip_id: string;
  status: TripStatus;
  route_name: string | null;
  depot_id: string | null;
  vehicle_id: string | null;
  driver_id: string | null;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  actual_start: Date | null;
  actual_end: Date | null;
  /** While under way (FMS-86); null otherwise or before the first estimate. */
  eta: TripEta | null;
  version: number;
  updated_at: Date;
}

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
  /**
   * How the distance was measured (FMS-145): the vehicle's own odometer or the GPS track. Null with no distance, or
   * with one entered before trips were measured (the seed, an import).
   */
  actual_distance_source: 'odometer' | 'gps' | null;
  stops: TripStopView[];
  /** While under way (FMS-86); null otherwise or before the first estimate. */
  eta: TripEta | null;
  /**
   * An assignment held for a fleet manager's approval (FMS-151): the trip's newest request while it waits, or once
   * it was refused (why, for the dispatcher). Null otherwise: none, approved or withdrawn.
   */
  exception: AssignmentExceptionView | null;
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
  /** A stop of a trip under way was marked done (FMS-95); the console reads it as `trip.updated`. */
  stopCompleted: 'TripStopCompleted',
  /** An assignment was held for a fleet manager's approval (FMS-151); the trip itself is unchanged. */
  exceptionRequested: 'AssignmentExceptionRequested',
  /** A fleet manager approved (the trip is assigned, TripAssigned too) or refused a held assignment (FMS-151). */
  exceptionDecided: 'AssignmentExceptionDecided',
} as const;

export const stopNotFound = () => new AppError(404, 'NOT_FOUND', 'Stop not found.');

/** Stops are completed while the trip is under way: not before it starts, nor after it ends. */
export const tripNotUnderWay = (status: TripStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `Stops are completed during the trip; this one is ${status.replace('_', ' ')}.`, [
    { field: 'status', reason: 'trip_not_under_way' },
  ]);

/** A position older than this is shown as stale on the live state (as the live map greys a vehicle, FMS-45). */
export const LIVE_POSITION_STALE_MS = 2 * 60_000;

/** GET /trips/{id}/live (FMS-95, api-contract §7.2): where a trip stands now. */
export interface TripLiveState {
  trip_id: string;
  status: TripStatus;
  vehicle_id: string | null;
  driver_id: string | null;
  /** The vehicle's newest position while the trip is under way; null otherwise or before its first. */
  position: { lat: number; lng: number; speed_kmh: number; heading: number | null; recorded_at: Date; stale: boolean } | null;
  /** The first stop not yet reached, completed or skipped, in order, with its estimate. */
  next_stop: { stop_id: string; sequence_number: number; name: string; eta: Date | null } | null;
  stops: { total: number; reached: number; completed: number };
  eta: TripEta | null;
  actual_start: Date | null;
  scheduled_end: Date | null;
  as_of: Date;
}

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
