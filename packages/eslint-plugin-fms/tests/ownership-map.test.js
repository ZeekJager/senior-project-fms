const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { MODULE_SCHEMAS, PLATFORM_OWNED_SCHEMAS, PLATFORM_SCHEMAS } = require('../lib/module-boundaries');

const backend = path.resolve(__dirname, '../../backend');

// The ownership map must keep up with the schema and the code: a new schema
// or a new module without an owner entry would otherwise slip past the rule.
test('every schema a migration creates has an owner', () => {
  const dir = path.join(backend, 'migrations');
  const created = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    for (const m of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      created.add(m[1].toLowerCase());
    }
  }
  const owned = new Set([...Object.values(MODULE_SCHEMAS).flat(), ...PLATFORM_SCHEMAS, ...PLATFORM_OWNED_SCHEMAS]);
  assert.ok(created.size >= 14, `expected the migrations to create the module schemas, found ${[...created]}`);
  assert.deepEqual([...created].filter((s) => !owned.has(s)), [], 'schemas without an owner in lib/module-boundaries.js');
});

test('every schema has exactly one owner', () => {
  const all = [...Object.values(MODULE_SCHEMAS).flat(), ...PLATFORM_SCHEMAS, ...PLATFORM_OWNED_SCHEMAS];
  assert.deepEqual(all.filter((s, i) => all.indexOf(s) !== i), []);
});

test('every backend module folder has an entry', () => {
  const dir = path.join(backend, 'src/modules');
  const modules = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.deepEqual(modules.filter((m) => !(m in MODULE_SCHEMAS)).sort(), []);
  assert.deepEqual(Object.keys(MODULE_SCHEMAS).filter((m) => !modules.includes(m)).sort(), []);
});
