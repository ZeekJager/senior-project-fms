import { assertNotProduction } from '../seed/guard';

/**
 * The load suite drops and recreates its database every run (FMS-61), so it never runs in production nor against a
 * database whose name does not end in `_test`. Checked on the raw environment before anything connects.
 */
export function assertLoadTarget(env: { NODE_ENV?: string }, dbName: string): void {
  assertNotProduction(env);
  if (!dbName.endsWith('_test')) throw new Error(`LOAD_DB_NAME must end with "_test" (got "${dbName}"): the load suite drops and recreates it.`);
}
