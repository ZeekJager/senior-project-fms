/**
 * Operations the API mounts that docs/openapi.yaml does not describe, so the reverse drift check
 * (test/integration/openapi.test.ts) can fail on a NEW undocumented route without failing on the old ones.
 *
 * Entries are written as the test compares them: the method, then the path under /api/v1 with every
 * parameter as {}.
 *
 * The check also runs the other way: an entry that is no longer mounted, or that the spec now describes,
 * fails the test. So documenting an operation means deleting its line here (FMS-119); the backlog only shrinks.
 */

/** Not under the API's /api/v1 base, so the spec (whose server is /api/v1) cannot list them. */
export const OUTSIDE_API_BASE: readonly string[] = [
  'GET /health/live',
  'GET /health/ready',
];

/**
 * Second mounts of operations the spec describes under their canonical path (the /maintenance mount of
 * /maintenance-records, /audit of /audit-logs). They behave identically, so one description serves both.
 * Never documented separately; /dvir is the exception and has its own entry in the spec.
 */
export const ALIASES: readonly string[] = [
  'GET /maintenance',
  'POST /maintenance',
  'GET /maintenance/{}',
  'PUT /maintenance/{}',
  'PATCH /maintenance/{}',
  'POST /maintenance/{}/complete',
  'POST /maintenance/{}/failures',
  'GET /audit',
];

/**
 * Written before the spec covered them and still to be described (SE-101 completes the spec, FMS-65).
 * Remove a line as its operation is added to docs/openapi.yaml.
 */
export const NOT_YET_DOCUMENTED: readonly string[] = [
  // auth
  'POST /auth/login',
  'POST /auth/refresh',
  'POST /auth/logout',
  'GET /auth/me',
  'POST /auth/password',
  // users
  'GET /users',
  'POST /users',
  'GET /users/{}',
  'PATCH /users/{}',
  'POST /users/{}/password-reset',
  // roles
  'GET /roles',
  // depots
  'GET /depots',
  'POST /depots',
  'GET /depots/{}',
  'PATCH /depots/{}',
  'PUT /depots/{}',
  'DELETE /depots/{}',
  'POST /depots/{}/reactivate',
  // attendance
  'GET /attendance',
  'POST /attendance',
  'GET /attendance/{}',
  'PUT /attendance/{}',
  'PATCH /attendance/{}',
  // vehicles
  'GET /vehicles',
  'POST /vehicles',
  'GET /vehicles/{}',
  'PATCH /vehicles/{}',
  'DELETE /vehicles/{}',
  // drivers
  'GET /drivers',
  'POST /drivers',
  'POST /drivers/import',
  'GET /drivers/me',
  'GET /drivers/{}',
  'PATCH /drivers/{}',
  'POST /drivers/{}/reinstate',
  'DELETE /drivers/{}',
  // documents
  'POST /documents',
  'GET /documents',
  'GET /documents/{}',
  'GET /documents/{}/content',
  'DELETE /documents/{}',
  // maintenance-records
  'GET /maintenance-records',
  'POST /maintenance-records',
  'GET /maintenance-records/{}',
  'PUT /maintenance-records/{}',
  'PATCH /maintenance-records/{}',
  'POST /maintenance-records/{}/complete',
  // inventory
  'GET /inventory',
  'GET /inventory/parts',
  'POST /inventory',
  'GET /inventory/{}',
  'PUT /inventory/{}',
  'POST /inventory/{}/adjust',
  'GET /inventory/{}/movements',
  // audit-logs
  'GET /audit-logs',
];
