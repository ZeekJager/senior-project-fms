// Imported first by scripts/seed.ts, before anything loads the config: refuses
// production, and keeps the in-process API's request log to warnings (one
// line per seeded row is noise; FMS_SEED_LOG_LEVEL=info brings it back).
import { assertNotProduction } from './guard';

try {
  assertNotProduction(process.env);
} catch (err) {
  console.error(`✖ ${(err as Error).message}`);
  process.exit(1);
}
process.env.LOG_LEVEL = process.env.FMS_SEED_LOG_LEVEL ?? 'warn';
