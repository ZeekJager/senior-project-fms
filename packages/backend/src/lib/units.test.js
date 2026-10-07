const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const units = require('./units');

test('toMillilitres returns integer millilitres', () => {
  assert.equal(units.toMillilitres(1.5), 1500);
  assert.ok(Number.isInteger(units.toMillilitres(23.456)));
});

test('toCents returns integer cents', () => {
  assert.equal(units.toCents(149.99), 14999);
  assert.ok(Number.isInteger(units.toCents(0.07)));
});

test('integer conversion avoids the 0.1 + 0.2 float error', () => {
  assert.equal(units.toMillilitres(0.1) + units.toMillilitres(0.2), units.toMillilitres(0.3));
  assert.equal(units.toCents(0.1) + units.toCents(0.2), units.toCents(0.3));
});

test('display helpers return fixed two-decimal strings', () => {
  assert.equal(units.toLitres(23500), '23.50');
  assert.equal(units.toBirr(14999), '149.99');
});

test('null and undefined pass through unchanged', () => {
  for (const fn of Object.values(units)) {
    assert.equal(fn(null), null);
    assert.equal(fn(undefined), undefined);
  }
});

// FMS-04: backend and frontend must convert identically.
test('frontend units.js exports the same functions with the same results', async () => {
  const frontendPath = path.resolve(__dirname, '../../../frontend/src/lib/units.js');
  const frontend = await import(pathToFileURL(frontendPath).href);
  assert.deepEqual(Object.keys(units).sort(), Object.keys(frontend).filter((k) => k !== 'default').sort());
  for (const input of [0, 0.1, 1.5, 23.456, 149.99]) {
    assert.equal(frontend.toMillilitres(input), units.toMillilitres(input));
    assert.equal(frontend.toCents(input), units.toCents(input));
  }
  for (const input of [0, 1500, 23500, 14999]) {
    assert.equal(frontend.toLitres(input), units.toLitres(input));
    assert.equal(frontend.toBirr(input), units.toBirr(input));
  }
});
