import { AppError } from '../../../shared/errors/app-error';

/** GET /vehicles/{vehicle_id}/tracking (FMS-136): how many points a page holds by default, and at most. */
export const TRACK_PAGE_DEFAULT = 500;
export const TRACK_PAGE_MAX = 1000;

/**
 * The longest window one request reads (FMS-95, api-contract §18: telemetry history enforces a maximum time range): 30 days,
 * so a 31-day request is refused. Without `from` the window is the 30 days up to `to` (or now).
 */
export const TRACK_MAX_RANGE_DAYS = 30;
const MAX_RANGE_MS = TRACK_MAX_RANGE_DAYS * 24 * 3600_000;

/**
 * The window to read: `to` defaults to now and `from` to 30 days before `to`; `to` before `from` or a window over 30
 * days is 400 VALIDATION_INVALID_DATE_RANGE.
 */
export function trackWindow(from: Date | null, to: Date | null, now: Date): { from: Date; to: Date } {
  const end = to ?? (from && from.getTime() + MAX_RANGE_MS < now.getTime() ? new Date(from.getTime() + MAX_RANGE_MS) : now);
  const start = from ?? new Date(end.getTime() - MAX_RANGE_MS);
  if (start >= end) throw new AppError(400, 'VALIDATION_INVALID_DATE_RANGE', '`to` must be after `from`.', [{ field: 'to', reason: 'before_from' }]);
  if (end.getTime() - start.getTime() > MAX_RANGE_MS) {
    throw new AppError(400, 'VALIDATION_INVALID_DATE_RANGE', `A history request covers at most ${TRACK_MAX_RANGE_DAYS} days: ask for the rest in another.`, [
      { field: 'to', reason: 'range_too_long' },
    ]);
  }
  return { from: start, to: end };
}

/** A stored ping as the history reads it: internal ids, numbers as numbers. */
export interface TrackPointRow {
  id: string;
  /** recorded_at to the microsecond (UTC), for the cursor. */
  at: string;
  recordedAt: Date;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number | null;
  altitudeM: number | null;
  accuracyM: number | null;
  ignitionOn: boolean | null;
  odometerKm: number | null;
  source: string;
  tripId: string | null;
}

/** A point of a vehicle's GPS history (api-contract §11, `GPSPoint` out). Public ids only. */
export interface TrackPointView {
  recorded_at: string;
  lat: number;
  lng: number;
  speed_kmh: number;
  heading: number | null;
  altitude_m: number | null;
  accuracy_m: number | null;
  ignition_on: boolean | null;
  odometer_km: number | null;
  source: string;
  trip_id: string | null;
}

export interface TrackQuery {
  from: Date | null;
  to: Date | null;
  limit: number;
  cursor: TrackCursor | null;
}

/** Where the next page starts: after this ping, in (recorded_at, id) order. */
export interface TrackCursor {
  at: string;
  id: string;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const NUMERIC = /^\d+$/;

export function encodeTrackCursor(cursor: TrackCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`).toString('base64url');
}

/** The cursor a page handed out; anything else is `400 invalid_cursor`. */
export function decodeTrackCursor(token: string): TrackCursor {
  const [at, id, extra] = Buffer.from(token, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !CURSOR_AT.test(at ?? '') || !NUMERIC.test(id ?? '') || id.length > 19) throw invalidTrackCursor();
  return { at, id };
}

const invalidTrackCursor = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The cursor is not valid. Start again from the first page.', [{ field: 'cursor', reason: 'invalid_cursor' }]);
