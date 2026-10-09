const assert = require('node:assert/strict');
const test = require('node:test');
const { sqlCode } = require('../lib/sql-code');

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const code = (sql) => squash(sqlCode(sql));

test('string literals are removed, including doubled quotes inside them', () => {
  assert.equal(code("SELECT 'fleet.depots', x FROM trip.trips"), 'SELECT , x FROM trip.trips');
  assert.equal(code("VALUES ('it''s fleet.depots') FROM t"), 'VALUES ( ) FROM t');
});

test("a -- inside a value does not start a comment", () => {
  assert.equal(code("VALUES ('a--b') FROM maintenance.records"), 'VALUES ( ) FROM maintenance.records');
});

test("E'...' strings end at the right quote despite backslash escapes", () => {
  assert.equal(code("SELECT E'it\\'s fleet.depots' FROM t"), 'SELECT E FROM t');
  // Only after an E that starts a token: "type'...'" is not an escape string.
  assert.equal(code("SELECT type'a\\' FROM t"), 'SELECT type FROM t');
});

test('comments are removed: line, block and nested block', () => {
  assert.equal(code('SELECT 1 -- fleet.depots\nFROM t'), 'SELECT 1 FROM t');
  assert.equal(code('SELECT /* fleet.depots /* nested */ still comment */ 1 FROM t'), 'SELECT 1 FROM t');
});

test('dollar-quoted bodies are removed; $1 placeholders are kept', () => {
  assert.equal(code('SELECT $$fleet.depots$$, $fn$ x $fn$ FROM t WHERE id = $1'), 'SELECT , FROM t WHERE id = $1');
});

test('quoted identifiers are code and are kept', () => {
  assert.equal(code('SELECT * FROM "maintenance"."records"'), 'SELECT * FROM "maintenance"."records"');
});

test('an unterminated quote or comment swallows the rest instead of throwing', () => {
  assert.equal(code("SELECT 'open FROM fleet.depots"), 'SELECT');
  assert.equal(code('SELECT 1 /* open FROM fleet.depots'), 'SELECT 1');
});
