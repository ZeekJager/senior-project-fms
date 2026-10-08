// Prints docs/permissions.md to stdout: npm run -s permissions:doc -w fms-backend > docs/permissions.md
import { pool } from '../src/db';
import { renderPermissionMatrix } from '../src/modules/auth/application/permission-matrix';

async function main(): Promise<void> {
  const res = await pool.query<{ role: string; permission: string }>(
    `SELECT r.name AS role, p.code AS permission
       FROM auth.role_permissions rp
       JOIN auth.roles r ON r.id = rp.role_id
       JOIN auth.permissions p ON p.id = rp.permission_id
      ORDER BY r.name, p.code`,
  );
  process.stdout.write(renderPermissionMatrix(res.rows));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
