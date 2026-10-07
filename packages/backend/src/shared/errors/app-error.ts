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
  'CONFLICT_DUPLICATE',
  'CONFLICT_DUPLICATE_PLATE',
  'CONFLICT_DUPLICATE_LICENSE',
  'CONFLICT_VEHICLE_IN_USE',
  'CONFLICT_DRIVER_IN_USE',
  'CONFLICT_DEPOT_NOT_EMPTY',
  'CONFLICT_DRIVER_OVERLAP',
  'CONFLICT_VEHICLE_OVERLAP',
  'CONFLICT_VEHICLE_FLAGGED',
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
}

/** An error the API reports to the client as-is (status, code, message). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'The requested resource was not found.') => new AppError(404, 'NOT_FOUND', message);

export const validationFailed = (details: ErrorDetail[], message = 'The request is invalid.') =>
  new AppError(400, 'VALIDATION_FAILED', message, details);
