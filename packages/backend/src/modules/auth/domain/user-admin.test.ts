import { describe, expect, test } from 'vitest';
import { mayAssignRole, passwordProblem } from './user-admin';

const ADMIN_PERMS = ['users:read', 'users:write', 'roles:read', 'vehicle:read', 'audit:read'];

describe('mayAssignRole', () => {
  const admin = { roles: ['admin'], permissions: ADMIN_PERMS };
  // A fleet manager given users:write (not the default): still no admin.
  const manager = { roles: ['fleet_manager'], permissions: ['users:read', 'users:write', 'roles:read', 'vehicle:read'] };

  test('only an admin grants or removes admin', () => {
    expect(mayAssignRole(admin, 'admin', ADMIN_PERMS)).toBe(true);
    expect(mayAssignRole(manager, 'admin', [])).toBe(false);
  });

  test('no role carrying a permission the caller lacks', () => {
    expect(mayAssignRole(manager, 'compliance_officer', ['audit:read', 'vehicle:read'])).toBe(false);
    expect(mayAssignRole(manager, 'fleet_owner', ['vehicle:read'])).toBe(true);
  });
});

describe('passwordProblem', () => {
  const email = 'hanna.d@test.fms';
  test.each([
    ['short-pass', 'too_short'],
    ['x'.repeat(129), 'too_long'],
    ['aaaaaaaaaaaaa', 'repeated_character'],
    ['HANNA.D@test.fms', 'contains_email'],
    ['my-hanna.d-password', 'contains_email'],
  ])('%s → %s', (password, reason) => {
    expect(passwordProblem(password, email)).toBe(reason);
  });

  test('a long passphrase passes; a short local part is not matched', () => {
    expect(passwordProblem('correct horse battery', email)).toBeNull();
    expect(passwordProblem('bob-has-a-long-password', 'bob@test.fms')).toBeNull();
  });
});
