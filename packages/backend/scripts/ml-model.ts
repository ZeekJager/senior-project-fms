/**
 * The predictive maintenance model registry (FMS-127): list the registered models, or let one score.
 *
 *   npm run ml:model -- list
 *   npm run ml:model -- activate pm-2026.10 --by admin@example.com
 *
 * Activating a model retires the one that was active; activating a retired model again is a rollback.
 * A model trained on other inputs than the core computes is refused. The same as
 * POST /api/v1/ml-models/{id}/activate, recorded in the audit log as the named administrator.
 */
import { pool } from '../src/db';
import { closeRedis } from '../src/shared/cache';
import { mlModelCommand } from './lib/ml-model-cli';

mlModelCommand(process.argv.slice(2), (line) => console.log(line))
  .catch((err: unknown) => {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), closeRedis()]));
