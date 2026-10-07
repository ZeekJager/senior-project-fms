import { AppError } from '../../../shared/errors/app-error';

// One message for unknown email and wrong password, so the response never
// reveals whether an account exists (api-contract §3.6).
export const invalidCredentials = () =>
  new AppError(401, 'AUTH_INVALID_CREDENTIALS', 'The email or password is incorrect.');

export const accountDisabled = () => new AppError(403, 'AUTH_ACCOUNT_DISABLED', 'This account is disabled.');

export const authenticationRequired = () => new AppError(401, 'AUTH_TOKEN_INVALID', 'Sign in to continue.');

export const tokenInvalid = () => new AppError(401, 'AUTH_TOKEN_INVALID', 'The session is not valid. Sign in again.');

export const tokenExpired = () => new AppError(401, 'AUTH_TOKEN_EXPIRED', 'The session has expired.');

export const tokenRevoked = () =>
  new AppError(401, 'AUTH_TOKEN_REVOKED', 'The session has been revoked. Sign in again.');

export const loginThrottled = (retryAfterSeconds: number) =>
  new AppError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.', undefined, {
    'Retry-After': String(retryAfterSeconds),
  });
