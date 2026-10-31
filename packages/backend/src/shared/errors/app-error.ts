/** Error codes from docs/api-contract.md §3.6. `error.code` is always one of these. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'VALIDATION_INVALID_ENUM',
  'VALIDATION_INVALID_DATE_RANGE',
  'VALIDATION_FLOAT_IN_MONEY_PATH',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_TOKEN_EXPIRED',
  'AUTH_TOKEN_INVALID',
  'AUTH_TOKEN_REVOKED',
  'AUTH_ACCOUNT_DISABLED',
  'FORBIDDEN_INSUFFICIENT_ROLE',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'CONFLICT_DUPLICATE',
  'CONFLICT_DUPLICATE_PLATE',
  'CONFLICT_DUPLICATE_LICENSE',
  'CONFLICT_VEHICLE_IN_USE',
  'CONFLICT_DRIVER_IN_USE',
  'CONFLICT_DEPOT_NOT_EMPTY',
  'CONFLICT_DRIVER_OVERLAP',
  'CONFLICT_VEHICLE_OVERLAP',
  'CONFLICT_VEHICLE_FLAGGED',
  'CONFLICT_DRIVER_NOT_ELIGIBLE',
  'CONFLICT_DEPOT_MISMATCH',
  'CONFLICT_ATTENDANCE_DUPLICATE',
  'CONFLICT_INVALID_STATE_TRANSITION',
  'CONFLICT_INSUFFICIENT_STOCK',
  'CONFLICT_ODOMETER_REGRESSION',
  'CONFLICT_CONCURRENT_MODIFICATION',
  'CONFLICT_IDEMPOTENCY_KEY_REUSED',
  'CONFLICT_IDEMPOTENCY_IN_PROGRESS',
  'RATE_LIMITED',
  'INTERNAL_SERVER_ERROR',
  'UPSTREAM_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDetail {
  field?: string;
  reason: string;
  /** The public id of the record the problem is about: the conflicting trip, the open maintenance record. */
  record_id?: string;
  /** For an invalid state transition: the states the record can move to from where it is. */
  allowed_transitions?: string[];
  /** For a trip clash (FMS-139): whether `shift_following` can move the other trip, and by how many minutes. */
  shiftable?: boolean;
  shift_minutes?: number;
}

/** An error the API reports to the client as-is (status, code, message). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
    /** Response headers that go with the error, e.g. `Retry-After` on 429. */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'The requested resource was not found.') => new AppError(404, 'NOT_FOUND', message);

export const validationFailed = (details: ErrorDetail[], message = 'The request is invalid.') =>
  new AppError(400, 'VALIDATION_FAILED', message, details);
