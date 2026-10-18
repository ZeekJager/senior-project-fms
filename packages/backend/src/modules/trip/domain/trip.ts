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

export const TRIP_EVENTS = {
  created: 'TripCreated',
  /** Rescheduled or moved to another route; changed_fields says what. */
  updated: 'TripUpdated',
  cancelled: 'TripCancelled',
} as const;

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
