import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkDefinition, checkValue, formatDuration, parseDuration, type ParameterRules, type ParameterType } from './parameter-types';

const reason = (type: ParameterType, rules: ParameterRules, value: unknown) => {
  const r = checkValue(type, rules, value);
  return r.ok ? 'ok' : r.reason;
};

describe('checkValue: one validator for the API and the Settings screen (FMS-157)', () => {
  test.each<[ParameterType, ParameterRules, unknown, string]>([
    ['integer', { min: 1, max: 10 }, 5, 'ok'],
    ['integer', { min: 1, max: 10 }, 11, 'out_of_range'],
    ['integer', {}, 70.5, 'wrong_type'],
    ['integer', {}, '5', 'wrong_type'],
    ['number', { min: 0.5, max: 3, decimals: 2 }, 1.25, 'ok'],
    ['number', { decimals: 2 }, 1.255, 'invalid_format'],
    ['number', {}, Number.NaN, 'wrong_type'],
    ['text', { max_length: 3 }, 'abcd', 'out_of_range'],
    ['text', { pattern: '[A-Z]{3}' }, 'ADD', 'ok'],
    ['text', { pattern: '[A-Z]{3}' }, 'ADDX', 'invalid_format'],
    ['boolean', {}, true, 'ok'],
    ['boolean', {}, 'true', 'wrong_type'],
    ['dropdown', { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }, 'b', 'ok'],
    ['dropdown', { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }, 'c', 'not_an_option'],
    ['multi_select', { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], max_items: 1 }, ['a', 'b'], 'out_of_range'],
    ['multi_select', { options: [{ value: 'a', label: 'A' }] }, ['a', 'a'], 'invalid_format'],
    ['multi_select', { options: [{ value: 'a', label: 'A' }] }, ['z'], 'not_an_option'],
    ['duration', { max: 3600 }, 900, 'ok'],
    ['duration', {}, -1, 'wrong_type'],
    ['duration', { max: 3600 }, 7200, 'out_of_range'],
    ['email', {}, 'ops@fleet.et', 'ok'],
    ['email', {}, 'ops@fleet', 'invalid_format'],
    ['url', {}, 'https://fleet.et/hook', 'ok'],
    ['url', {}, 'ftp://fleet.et', 'invalid_format'],
    ['url', {}, 'not a url', 'invalid_format'],
    ['json', { schema: { type: 'object', required: ['hour'], properties: { hour: { type: 'integer', minimum: 0, maximum: 23 } }, additionalProperties: false } }, { hour: 18 }, 'ok'],
    ['json', { schema: { type: 'object', required: ['hour'], properties: { hour: { type: 'integer', minimum: 0, maximum: 23 } } } }, { hour: 25 }, 'invalid_format'],
    ['json', { schema: { type: 'object', additionalProperties: false, properties: {} } }, { extra: 1 }, 'invalid_format'],
    ['json', { schema: { type: 'array', items: { enum: ['a', 'b'] }, uniqueItems: true } }, ['a', 'a'], 'invalid_format'],
  ])('%s %j: %j is %s', (type, rules, value, expected) => {
    expect(reason(type, rules, value)).toBe(expected);
  });

  test('a JSON Schema failure says where', () => {
    const r = checkValue('json', { schema: { type: 'object', properties: { stops: { type: 'array', items: { type: 'string' } } } } }, { stops: ['a', 2] });
    expect(r).toEqual({ ok: false, reason: 'invalid_format', message: 'Expected string at /stops/1.' });
  });
});

describe('checkDefinition', () => {
  test('a sound definition has no problems', () => {
    expect(checkDefinition('dropdown', { options: [{ value: 'low', label: 'Low' }, { value: 'mid', label: 'Mid' }, { value: 'high', label: 'High' }] }, 'mid')).toEqual([]);
  });

  test('rules the type does not take, ranges the wrong way, repeated options and a bad default are refused', () => {
    expect(checkDefinition('boolean', { min: 1 }, true).map((p) => [p.field, p.reason])).toEqual([['rules.min', 'invalid_rules']]);
    expect(checkDefinition('integer', { min: 10, max: 1 }, 5).map((p) => p.field)).toEqual(['rules.max']);
    expect(checkDefinition('dropdown', { options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }, 'a').map((p) => p.field)).toEqual(['rules.options.1']);
    expect(checkDefinition('dropdown', { options: [{ value: 'a', label: 'A' }] }, 'a').map((p) => p.field)).toEqual(['rules.options']);
    expect(checkDefinition('text', { pattern: '(' }, 'x').map((p) => p.field)).toEqual(['rules.pattern']);
    expect(checkDefinition('integer', { min: 1, max: 5 }, 9).map((p) => [p.field, p.reason])).toEqual([['default_value', 'invalid_default']]);
    expect(checkDefinition('integer', {}, null).map((p) => p.field)).toEqual(['default_value']);
  });

  test('a JSON Schema with a keyword the json type does not check is refused, so nothing is silently ignored', () => {
    const problems = checkDefinition('json', { schema: { type: 'object', properties: { a: { type: 'string', format: 'date' } }, oneOf: [] } }, {});
    expect(problems.map((p) => p.reason)).toEqual(['unsupported_schema_keyword']);
    expect(problems[0].message).toContain('/: oneOf');
    expect(problems[0].message).toContain('/properties/a: format');
  });
});

describe('durations', () => {
  test.each([
    ['90', 5400],
    ['1h 30m', 5400],
    ['1h30min', 5400],
    ['2 d', 172800],
    ['45s', 45],
    ['soon', null],
    ['1h soon', null],
  ])('%s is %s seconds', (text, seconds) => {
    expect(parseDuration(text)).toBe(seconds);
  });

  test('written back', () => {
    expect(formatDuration(5400)).toBe('1 h 30 min');
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(90061)).toBe('1 d 1 h 1 min 1 s');
  });
});

// The Settings screen runs this very file: packages/frontend/src/lib/parameterTypes.ts must be the same, byte for byte.
test('the frontend copy is identical', () => {
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const backend = read(path.resolve(__dirname, 'parameter-types.ts'));
  const frontend = read(path.resolve(__dirname, '../../../../../frontend/src/lib/parameterTypes.ts'));
  expect(frontend).toBe(backend);
});
