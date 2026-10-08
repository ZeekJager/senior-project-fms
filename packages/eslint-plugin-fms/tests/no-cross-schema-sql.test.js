const rule = require('../rules/no-cross-schema-sql');
const { tsRuleTester, backend } = require('./rule-tester');

const trip = backend('src/modules/trip/infrastructure/trip.repository.ts');
const fleet = backend('src/modules/fleet/infrastructure/depot.repository.ts');
const integration = backend('src/modules/integration/infrastructure/ping.repository.ts');
const commandCenter = backend('src/modules/command-center/infrastructure/board.ts');

tsRuleTester().run('no-cross-schema-sql', rule, {
  valid: [
    // Own schema, in a template literal and in a plain string.
    { filename: trip, code: 'db.query(`SELECT t.id FROM trip.trips t JOIN trip.routes r ON r.id = t.route_id WHERE t.id = $1`, [id]);' },
    { filename: trip, code: "db.query('UPDATE trip.trips SET status = $2 WHERE id = $1', [id, s]);" },
    // A module that owns two schemas.
    { filename: fleet, code: 'db.query(`SELECT * FROM document.documents d JOIN fleet.vehicles v ON v.id = d.entity_id`);' },
    { filename: integration, code: 'db.query(`INSERT INTO tracking.gps_pings (vehicle_id) VALUES ($1)`);' },
    // The platform `shared` schema (types and functions) is open to every module.
    { filename: trip, code: "db.query(`UPDATE trip.trips SET status = $1::shared.user_status`);" },
    // Aliases and columns are not schemas.
    { filename: trip, code: 'db.query(`SELECT r.depot_id, t.public_id FROM trip.trips t JOIN trip.routes r ON true`);' },
    // Another schema's name inside a quoted SQL value or a comment is data, not a table.
    { filename: trip, code: "db.query(`INSERT INTO trip.trips (origin) VALUES ('fleet.depots') -- see fleet.depots`);" },
    { filename: trip, code: 'db.query(`SELECT 1 FROM trip.trips /* not maintenance.maintenance_records */`);' },
    // Strings that are not SQL: audit action names, messages.
    { filename: trip, code: "const action = 'maintenance.flag_cleared';" },
    { filename: trip, code: "log('maintenance.records sync done');" },
    // Own table through the audited-mutation helpers.
    { filename: trip, code: "await req.dbMutate('trip.trips', 'INSERT', null, data);" },
    // Files outside a module are not checked (shared code, migrations runner, tests).
    { filename: backend('src/shared/infrastructure/audit-log.ts'), code: 'db.query(`INSERT INTO audit.audit_logs (action) VALUES ($1)`);' },
    { filename: backend('test/integration/x.test.ts'), code: 'pool.query(`SELECT * FROM maintenance.maintenance_records`);' },
  ],
  invalid: [
    // AC: SELECT ... FROM maintenance.maintenance_records inside modules/trip fails.
    {
      filename: trip,
      code: 'db.query(`SELECT id, vehicle_id FROM maintenance.maintenance_records WHERE vehicle_id = $1`, [v]);',
      errors: [{ messageId: 'crossSchema', data: { module: 'trip', schema: 'maintenance', owner: "module 'maintenance'" } }],
    },
    { filename: trip, code: "db.query('SELECT * FROM maintenance.maintenance_records');", errors: [{ messageId: 'crossSchema' }] },
    // A join "just this once" is still cross-schema (rule 4).
    {
      filename: trip,
      code: 'db.query(`SELECT t.id FROM trip.trips t JOIN fleet.vehicles v ON v.id = t.vehicle_id`);',
      errors: [{ messageId: 'crossSchema', data: { module: 'trip', schema: 'fleet', owner: "module 'fleet'" } }],
    },
    // Writes, upper case, quoted identifiers, and an interpolated template.
    { filename: trip, code: 'db.query(`INSERT INTO audit.audit_logs (action) VALUES ($1)`);', errors: [{ messageId: 'crossSchema' }] },
    { filename: trip, code: 'db.query(`select * from MAINTENANCE.Maintenance_Records`);', errors: [{ messageId: 'crossSchema' }] },
    { filename: trip, code: 'db.query(`SELECT * FROM "maintenance"."maintenance_records"`);', errors: [{ messageId: 'crossSchema' }] },
    { filename: trip, code: 'db.query(`SELECT * FROM maintenance.maintenance_records WHERE id = ${id} AND x = 1`);', errors: [{ messageId: 'crossSchema' }] },
    // Two foreign schemas in one statement: one report each.
    {
      filename: trip,
      code: 'db.query(`SELECT 1 FROM fleet.vehicles v JOIN fuel.fuel_logs f ON f.vehicle_id = v.id JOIN fleet.drivers d ON true`);',
      errors: [{ messageId: 'crossSchema', data: { module: 'trip', schema: 'fleet', owner: "module 'fleet'" } }, { messageId: 'crossSchema', data: { module: 'trip', schema: 'fuel', owner: "module 'fuel'" } }],
    },
    // Another module's table through the audited-mutation helpers.
    { filename: trip, code: "await req.dbMutate('maintenance.maintenance_records', 'UPDATE', id, data);", errors: [{ messageId: 'crossSchema' }] },
    { filename: trip, code: "await this.mutate(ctx, 'fleet.vehicles', 'UPDATE', id, data);", errors: [{ messageId: 'crossSchema' }] },
    // A schema of platform code in src/shared is not open to modules.
    {
      filename: trip,
      code: 'db.query(`SELECT * FROM api.idempotency_keys`);',
      errors: [{ messageId: 'crossSchema', data: { module: 'trip', schema: 'api', owner: 'platform code in src/shared' } }],
    },
    // A module that owns no schema reads nothing directly.
    { filename: commandCenter, code: 'db.query(`SELECT * FROM tracking.vehicle_current_location`);', errors: [{ messageId: 'crossSchema' }] },
  ],
});
