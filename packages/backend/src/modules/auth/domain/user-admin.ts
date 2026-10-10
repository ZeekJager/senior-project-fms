import { AppError } from '../../../shared/errors/app-error';
import type { UserStatus } from './auth-policy';

export const USER_STATUSES: readonly UserStatus[] = ['active', 'inactive', 'suspended', 'locked'];

/** Roles whose holders see one depot only (depotScope): they need a home depot or they see nothing. */
export const DEPOT_SCOPED_ROLES: readonly string[] = ['dispatcher', 'driver', 'technician', 'depot_admin', 'finance_clerk'];

/** Setup links last long enough to reach a new driver; reset links are short. */
export const SETUP_TOKEN_TTL_SECONDS = 72 * 60 * 60;
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

/** A user as GET /users returns it (api-contract §5.1). Public ids only. */
export interface UserView {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  depot_id: string | null;
  status: UserStatus;
  roles: string[];
  /** False until a password is set (accounts created without one sign in only after the setup link). */
  has_password: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RoleView {
  name: string;
  description: string | null;
  permissions: string[];
}

/** A one-time link to set a password, shown once to the admin who issued it. */
export interface PasswordTokenView {
  token: string;
  purpose: 'setup' | 'reset';
  expires_at: Date;
}

export const USER_ADMIN_EVENTS = {
  created: 'UserCreated',
  roleChanged: 'UserRoleChanged',
  deactivated: 'UserDeactivated',
} as const;

/**
 * Whether `caller` may grant or take away `role` (whose permissions are
 * `rolePermissions`). Two rules on top of users:write: the admin role only
 * by an admin, and no role that carries a permission the caller lacks, so
 * nobody can hand out more than they hold. Pure, for unit tests.
 */
export function mayAssignRole(
  caller: { roles: readonly string[]; permissions: readonly string[] },
  role: string,
  rolePermissions: readonly string[],
): boolean {
  if (role === 'admin' && !caller.roles.includes('admin')) return false;
  return rolePermissions.every((p) => caller.permissions.includes(p));
}

/**
 * Passwords (NIST SP 800-63B): length over composition rules. 12 to 128
 * characters, not the email or its name part, not one repeated character.
 */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 12) return 'too_short';
  if (password.length > 128) return 'too_long';
  const lower = password.toLowerCase();
  const local = email.toLowerCase().split('@')[0];
  if (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local))) return 'contains_email';
  if (/^(.)\1*$/.test(password)) return 'repeated_character';
  return null;
}

export const userNotFound = () => new AppError(404, 'NOT_FOUND', 'User not found.');

export const emailTaken = () =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'An account with this email already exists.', [{ field: 'email', reason: 'already_exists' }]);

export const unknownRole = (index: number) =>
  new AppError(400, 'VALIDATION_FAILED', 'No active role with this name.', [{ field: `roles.${index}`, reason: 'references_missing_record' }]);

export const roleEscalation = (role: string) =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', `You cannot grant or remove the ${role} role: it carries permissions you do not hold.`, [
    { field: 'roles', reason: 'escalation' },
  ]);

export const ownRolesForbidden = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'You cannot change your own roles. Ask another administrator.', [
    { field: 'roles', reason: 'own_roles' },
  ]);

export const ownStatusForbidden = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'You cannot deactivate your own account.', [{ field: 'status', reason: 'own_account' }]);

export const lastAdmin = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'This is the last active administrator: add another before removing or deactivating this one.', [
    { reason: 'last_admin' },
  ]);

export const depotRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'These roles see one depot only: give the user a home depot.', [{ field: 'depot_id', reason: 'required' }]);

export const userDepotNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The depot does not exist.', [{ field: 'depot_id', reason: 'references_missing_record' }]);

export const weakPassword = (reason: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'Choose a password of 12 to 128 characters that does not contain your email.', [
    { field: 'password', reason },
  ]);

/** Unknown, used or expired: one answer, so the response says nothing about which. */
export const passwordTokenInvalid = () =>
  new AppError(400, 'VALIDATION_FAILED', 'This link is not valid or has expired. Ask an administrator for a new one.', [
    { field: 'token', reason: 'invalid_or_expired' },
  ]);
