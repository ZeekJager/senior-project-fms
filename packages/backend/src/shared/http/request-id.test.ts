import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequestId } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('a client UUID is kept (normalised to lower case)', () => {
  assert.equal(resolveRequestId('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
});

test('anything else is replaced by a new UUID v4', () => {
  for (const header of [undefined, '', 'abc', "1'; DROP TABLE x; --", '3f2504e0-4f89-41d3-9a0c-0305e82c3301-extra']) {
    assert.match(resolveRequestId(header), UUID);
  }
});

test('a repeated header uses the first value', () => {
  assert.equal(resolveRequestId(['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'abc']), '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
});
