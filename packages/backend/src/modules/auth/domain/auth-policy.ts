/** Session lifetimes and login throttling (FMS-05). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The 6th failed login for the same account and IP within the window gets 429. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

export type UserStatus = 'active' | 'inactive' | 'suspended' | 'locked';

/** `audit.audit_logs.action` values written by the auth module. */
export type AuthAuditAction =
  | 'auth.login_succeeded'
  | 'auth.login_failed'
  | 'auth.login_throttled'
  | 'auth.logout'
  | 'auth.refresh_reuse_detected';
