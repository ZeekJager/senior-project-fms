/**
 * The seed and its reset never touch production (FMS-113). Checked before
 * anything connects, on the raw environment, so a production config cannot
 * even be loaded by the seed. Imports nothing, on purpose.
 */
export function assertNotProduction(env: { NODE_ENV?: string }): void {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production. The seed and --reset are for local and CI databases only.');
  }
}
