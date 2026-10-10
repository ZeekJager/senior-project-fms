/**
 * Creates a user who can sign in, until user administration (POST /users)
 * exists. Run inside the backend container:
 *
 *   npm run user:create -- --email admin@fms.local --name "Admin" --role admin
 *   npm run user:create -- --email d@fms.local --name "Dispatcher" --role dispatcher --depot ADD-01
 *
 * The password comes from FMS_USER_PASSWORD, or is generated and printed once.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pool } from '../src/db';
import { hashPassword } from '../src/modules/auth';
import { auditedMutation } from '../src/shared/infrastructure/audited-mutation';
import { withTransaction } from '../src/shared/infrastructure/transaction';

function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}

const USAGE = 'Usage: npm run user:create -- --email <email> --name <full name> --role <role> [--role <role>] [--depot <depot code>]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', multiple: true },
      depot: { type: 'string' },
    },
  });
  if (!values.email || !values.name || !values.role?.length) throw new Error(USAGE);

  const fromEnv = process.env.FMS_USER_PASSWORD;
  const password = fromEnv || generatePassword();
  const roles = values.role;

  const created = await withTransaction(pool, async (client) => {
    let depotId: string | null = null;
    if (values.depot) {
      const depot = await client.query<{ id: string }>('SELECT id FROM fleet.depots WHERE code = upper(btrim($1))', [values.depot]);
      if (!depot.rows[0]) throw new Error(`No depot with code '${values.depot}'`);
      depotId = depot.rows[0].id;
    }
    const user = await auditedMutation(client, { userId: null, correlationId: randomUUID() }, 'auth.users', 'INSERT', null, {
      email: values.email!.trim().toLowerCase(),
      password_hash: await hashPassword(password),
      full_name: values.name,
      depot_id: depotId,
    });
    const granted = await client.query(
      `INSERT INTO auth.user_roles (user_id, role_id)
       SELECT $1, id FROM auth.roles WHERE name = ANY($2::text[])`,
      [user.id, roles],
    );
    if (granted.rowCount !== roles.length) throw new Error(`Unknown role in [${roles.join(', ')}]`);
    return user;
  });

  console.log(`✔ Created ${String(created.email)} (${roles.join(', ')}), id ${String(created.public_id)}`);
  if (!fromEnv) console.log(`  Generated password (shown once): ${password}`);
}

main()
  .catch((err: unknown) => {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
