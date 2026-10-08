export interface RoleGrant {
  role: string;
  permission: string;
}

/** Column order: the broadest roles first. */
const ROLE_ORDER = [
  'admin',
  'fleet_manager',
  'dispatcher',
  'depot_admin',
  'technician',
  'driver',
  'finance_clerk',
  'compliance_officer',
  'fleet_owner',
];

/**
 * The role x permission matrix as Markdown, generated from the grants seeded
 * in migration 001 so the document can never disagree with the database
 * (a test fails when `docs/permissions.md` is stale).
 */
export function renderPermissionMatrix(grants: RoleGrant[]): string {
  const known = new Set(grants.map((g) => g.role));
  const roles = [...ROLE_ORDER.filter((r) => known.has(r)), ...[...known].filter((r) => !ROLE_ORDER.includes(r)).sort()];
  const permissions = [...new Set(grants.map((g) => g.permission))].sort();
  const granted = new Set(grants.map((g) => `${g.role}|${g.permission}`));

  const header = `| Permission | ${roles.join(' | ')} |`;
  const rule = `|---|${roles.map(() => ':-:').join('|')}|`;
  const rows = permissions.map(
    (p) => `| \`${p}\` | ${roles.map((r) => (granted.has(`${r}|${p}`) ? 'x' : '')).join(' | ')} |`,
  );

  return [
    '# Role and permission matrix',
    '',
    'Generated from the role grants seeded in `packages/backend/migrations/001_core_identity.sql`. Do not edit by hand: run',
    '`npm run -s permissions:doc -w fms-backend > docs/permissions.md` after changing a grant. A test fails when this file is stale.',
    '',
    `${permissions.length} permissions, ${roles.length} roles. \`x\` means the role holds the permission.`,
    '',
    header,
    rule,
    ...rows,
    '',
  ].join('\n');
}
