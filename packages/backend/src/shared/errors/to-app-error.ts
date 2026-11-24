import { DatabaseError } from 'pg';
import { AppError, type ErrorCode, type ErrorDetail } from './app-error';

// Constraint name -> contract error code. Unlisted unique violations fall
// back to CONFLICT_DUPLICATE.
const UNIQUE_CONSTRAINTS: Record<string, ErrorCode> = {
  uq_fleet_vehicle_registration: 'CONFLICT_DUPLICATE_PLATE',
  // Licence numbers are encrypted at rest; their uniqueness is on the blind index (migration 063, FMS-104).
  ux_drivers_license_number_idx: 'CONFLICT_DUPLICATE_LICENSE',
  driver_attendance_driver_id_attendance_date_key: 'CONFLICT_ATTENDANCE_DUPLICATE',
};

const EXCLUSION_CONSTRAINTS: Record<string, ErrorCode> = {
  ex_trip_driver_overlap: 'CONFLICT_DRIVER_OVERLAP',
  ex_trip_vehicle_overlap: 'CONFLICT_VEHICLE_OVERLAP',
};

const INTERNAL_MESSAGE = 'An unexpected error occurred.';

/** Column names from a detail like `Key (a, b)=(1, 2) already exists.`; never the values. */
function keyColumns(detail: string | undefined): string[] {
  const m = detail?.match(/^Key \(([^)]+)\)=/);
  return m ? m[1].split(',').map((c) => c.trim()) : [];
}

function fromDatabaseError(err: DatabaseError): AppError | null {
  const constraint = err.constraint ?? '';
  switch (err.code) {
    case '23505': {
      const code = UNIQUE_CONSTRAINTS[constraint] ?? 'CONFLICT_DUPLICATE';
      const details = keyColumns(err.detail).map((field): ErrorDetail => ({ field, reason: 'already_exists' }));
      return new AppError(409, code, 'A record with the same value already exists.', details);
    }
    case '23P01': {
      const code = EXCLUSION_CONSTRAINTS[constraint];
      return code
        ? new AppError(409, code, 'The time window overlaps an existing assignment.')
        : new AppError(409, 'CONFLICT_DUPLICATE', 'The record conflicts with an existing one.');
    }
    case '23514':
      return new AppError(400, 'VALIDATION_FAILED', 'A value is outside the allowed range.', [
        { reason: `check_violation:${constraint}` },
      ]);
    case '23502':
      return new AppError(400, 'VALIDATION_FAILED', 'A required value is missing.', [
        { field: err.column, reason: 'required' },
      ]);
    case '23503':
      // Inserts/updates that point at a missing record. A blocked delete
      // ("update or delete on table ...") is left as a 500: core entities are
      // soft-deleted, so reaching it is a bug.
      if (err.message.startsWith('insert or update')) {
        return new AppError(
          400,
          'VALIDATION_FAILED',
          'A referenced record does not exist.',
          keyColumns(err.detail).map((field) => ({ field, reason: 'references_missing_record' })),
        );
      }
      return null;
    case '22P02':
      return new AppError(400, 'VALIDATION_FAILED', 'A value has the wrong format.', [{ reason: 'invalid_format' }]);
    default:
      return null;
  }
}

interface BodyParserError {
  type?: string;
}

/** How long a client waits before trying again while the database is unavailable (a failover takes seconds to minutes). */
export const DATABASE_RETRY_AFTER_SECONDS = 5;

/**
 * SQLSTATEs of a database that is going away, starting, failing over, or is a standby being promoted (FMS-162):
 * class 08 (connection exceptions), 57P01-57P03 (shut down by an administrator, crashed, cannot connect now), and
 * 25006 (a write that reached a read-only standby in the moment the endpoint moves).
 */
const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '25006']);
/** Node and pg errors of a database that cannot be reached at all. */
const UNAVAILABLE_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'EPIPE']);
const UNAVAILABLE_MESSAGES = [/^Connection terminated/i, /timeout exceeded when trying to connect/i, /Client has encountered a connection error/i];

/** Whether an error means the database is unavailable for now, rather than that the request was wrong. */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (err instanceof DatabaseError) return err.code !== undefined && (err.code.startsWith('08') || UNAVAILABLE_SQLSTATES.has(err.code));
  const e = err as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string' && UNAVAILABLE_ERRNOS.has(e.code)) return true;
  return typeof e?.message === 'string' && UNAVAILABLE_MESSAGES.some((m) => m.test(e.message as string));
}

/** 503 with Retry-After: the phone's queue, devices and webhooks retry, so nothing sent meanwhile is lost (FMS-162). */
export const databaseUnavailable = () =>
  new AppError(503, 'UPSTREAM_UNAVAILABLE', 'The database is unavailable for a moment. Try again shortly; nothing was saved.', [{ reason: 'database_unavailable' }], {
    'Retry-After': String(DATABASE_RETRY_AFTER_SECONDS),
  });

/** Normalises anything thrown in a request into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (isDatabaseUnavailable(err)) return databaseUnavailable();
  if (err instanceof DatabaseError) {
    return fromDatabaseError(err) ?? new AppError(500, 'INTERNAL_SERVER_ERROR', INTERNAL_MESSAGE);
  }
  const type = (err as BodyParserError | null)?.type;
  if (type === 'entity.parse.failed') {
    return new AppError(400, 'VALIDATION_FAILED', 'The request body is not valid JSON.', [{ reason: 'malformed_json' }]);
  }
  if (type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }
  return new AppError(500, 'INTERNAL_SERVER_ERROR', INTERNAL_MESSAGE);
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: ErrorDetail[]; stack?: string };
  meta: { request_id: string; timestamp: string };
}

/** The contract's error envelope (api-contract §3.4). `stack` only in development. */
export function errorBody(appErr: AppError, requestId: string, stack?: string): ErrorBody {
  return {
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details?.length ? { details: appErr.details } : {}),
      ...(stack ? { stack } : {}),
    },
    meta: { request_id: requestId, timestamp: new Date().toISOString() },
  };
}
