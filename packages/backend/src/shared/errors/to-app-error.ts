import { DatabaseError } from 'pg';
import { AppError, type ErrorCode, type ErrorDetail } from './app-error';

// Constraint name -> contract error code. Unlisted unique violations fall
// back to CONFLICT_DUPLICATE.
const UNIQUE_CONSTRAINTS: Record<string, ErrorCode> = {
  uq_fleet_vehicle_registration: 'CONFLICT_DUPLICATE_PLATE',
  drivers_license_number_key: 'CONFLICT_DUPLICATE_LICENSE',
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

/** Normalises anything thrown in a request into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
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
