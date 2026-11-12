/**
 * The trip risk model's training data (FMS-155, docs/ml-trip-risk.md): every completed, measured trip with its inputs as
 * of its scheduled start and its labels, as CSV in packages/ai-service/trip_risk_spec.json's columns.
 *
 *   npm run ml:trip-risk-dataset -w fms-backend -- --out ../ai-service/data/trip_risk_fleet.csv
 *   cd packages/ai-service && python scripts/train_trip_risk.py --data data/trip_risk_fleet.csv
 *
 * Read from the analytics views (the read replica when there is one). Ids are public ids; nothing personal. Training
 * refuses fewer than 2,000 trips across 20 drivers, so a young fleet's export says how far it has to go.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pool, replicaPool } from '../src/db';
import { tripRisk } from '../src/modules/analytics';
import { closeRedis } from '../src/shared/cache';

const USAGE = 'Usage: npm run ml:trip-risk-dataset -w fms-backend -- --out <file.csv>';

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { out: { type: 'string' } } });
  if (!values.out) throw new Error(USAGE);
  const { csv, trips, drivers } = await tripRisk.dataset();
  const out = path.resolve(values.out);
  writeFileSync(out, csv, 'utf8');
  console.log(`✔ ${trips.toLocaleString('en')} trips of ${drivers} drivers -> ${out}`);
  if (trips < 2000 || drivers < 20) console.log('  Not enough trips yet to train on: the model needs 2,000 completed, measured trips across 20 drivers.');
}

main()
  .catch((err: unknown) => {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), replicaPool?.end(), closeRedis()]));
