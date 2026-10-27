import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pool } from '../../src/db';
import { mlModelAdmin, type MlModelView } from '../../src/modules/maintenance';

export const ML_MODEL_USAGE = [
  'Usage: npm run ml:model -- list [--status registered|active|retired]',
  '       npm run ml:model -- activate <version> --by <admin email> [--name predictive-maintenance]',
].join('\n');

const STATUSES = ['registered', 'active', 'retired'] as const;
const DEFAULT_NAME = 'predictive-maintenance';
/** The registry holds a model per release: one page is all of it. */
const ALL = { page: 1, page_size: 100 };

const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '-');

function describe(m: MlModelView): string {
  const auc = typeof m.metrics.roc_auc === 'number' ? m.metrics.roc_auc.toFixed(3) : '-';
  return [
    m.version.padEnd(16),
    m.status.padEnd(10),
    (m.features_match ? 'yes' : 'NO').padEnd(14),
    auc.padEnd(7),
    day(m.first_seen_at).padEnd(17),
    day(m.activated_at),
  ].join(' ');
}

/** The administrator's internal id: an active account holding ml-model:activate. */
async function administrator(email: string): Promise<string> {
  const res = await pool.query<{ id: string; allowed: boolean }>(
    `SELECT u.id, EXISTS (
              SELECT 1 FROM auth.user_roles ur
                JOIN auth.role_permissions rp ON rp.role_id = ur.role_id
                JOIN auth.permissions p ON p.id = rp.permission_id
               WHERE ur.user_id = u.id AND p.code = 'ml-model:activate') AS allowed
       FROM auth.users u WHERE lower(u.email) = lower($1) AND u.status = 'active'`,
    [email.trim()],
  );
  const user = res.rows[0];
  if (!user) throw new Error(`No active account '${email}'`);
  if (!user.allowed) throw new Error(`'${email}' may not activate a model (ml-model:activate, administrators)`);
  return user.id;
}

/**
 * The model registry from the command line (FMS-127, docs/ml-model-registry.md): list it, or let a
 * registered model score. Activation is recorded as the named administrator, as from the API.
 */
export async function mlModelCommand(argv: string[], out: (line: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { status: { type: 'string' }, by: { type: 'string' }, name: { type: 'string' } },
  });
  const [command, version] = positionals;

  if (command === 'list') {
    const status = values.status as (typeof STATUSES)[number] | undefined;
    if (status !== undefined && !STATUSES.includes(status)) throw new Error(ML_MODEL_USAGE);
    const { items } = await mlModelAdmin.list({ ...ALL, status });
    if (items.length === 0) {
      out('No model registered yet: the scoring job registers the one the ML service serves.');
      return;
    }
    out(['VERSION'.padEnd(16), 'STATUS'.padEnd(10), 'FEATURES MATCH'.padEnd(14), 'ROC-AUC', 'FIRST SEEN (UTC)'.padEnd(17), 'ACTIVATED (UTC)'].join(' '));
    for (const m of items) out(describe(m));
    return;
  }

  if (command === 'activate' && version && values.by) {
    const name = values.name ?? DEFAULT_NAME;
    const found = await pool.query<{ public_id: string }>('SELECT public_id FROM maintenance.ml_models WHERE name = $1 AND version = $2', [name, version]);
    if (!found.rows[0]) throw new Error(`No registered model ${name} ${version}: list them with npm run ml:model -- list`);
    const userId = await administrator(values.by);
    const model = await mlModelAdmin.activate(found.rows[0].public_id, { userId, correlationId: randomUUID() });
    out(`✔ ${model.name} ${model.version} is active: the nightly scoring scores with it while the ML service serves it.`);
    return;
  }

  throw new Error(ML_MODEL_USAGE);
}
