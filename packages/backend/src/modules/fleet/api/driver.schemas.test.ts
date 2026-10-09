import { describe, expect, test } from 'vitest';
import { AppError } from '../../../shared/errors/app-error';
import { parseInput } from '../../../shared/http/validate';
import { driverCreateBody, driverListQuery, driverUpdateBody } from './driver.schemas';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const valid = { user_id: UUID, license_number: 'AA 12345', license_expiry: '2030-06-30', depot_id: UUID };

function rejection(schema: Parameters<typeof parseInput>[0], input: unknown): AppError {
  try {
    parseInput(schema, input);
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected the input to be rejected');
}

describe('driverCreateBody', () => {
  test('normalizes the licence number', () => {
    expect(parseInput(driverCreateBody, { ...valid, license_number: '  aa   12-345/b ' }).license_number).toBe('AA 12-345/B');
  });

  test.each([
    ['license_expiry', '2030-13-01'],
    ['license_expiry', '30/06/2030'],
    ['license_number', ''],
    ['license_number', 'AA#1'],
    ['emergency_phone', 'call me'],
    ['user_id', 'not-a-uuid'],
  ])('rejects %s = %j', (field, value) => {
    expect(rejection(driverCreateBody, { ...valid, [field]: value }).details?.map((d) => d.field)).toContain(field);
  });

  test('a hire date in the future is rejected; today and the past are fine', () => {
    expect(rejection(driverCreateBody, { ...valid, hire_date: '2999-01-01' }).details).toEqual([{ field: 'hire_date', reason: 'in_future' }]);
    expect(() => parseInput(driverCreateBody, { ...valid, hire_date: '2020-01-01' })).not.toThrow();
  });

  test('account fields are not writable here', () => {
    expect(rejection(driverCreateBody, { ...valid, full_name: 'X', phone: '+251' }).details).toEqual(
      expect.arrayContaining([
        { field: 'full_name', reason: 'not_writable' },
        { field: 'phone', reason: 'not_writable' },
      ]),
    );
  });
});

describe('license_categories', () => {
  test('European categories, deduplicated and in licence order', () => {
    expect(parseInput(driverCreateBody, { ...valid, license_categories: ['CE', 'B', 'C', 'B'] }).license_categories).toEqual(['B', 'C', 'CE']);
    expect(parseInput(driverCreateBody, { ...valid, license_categories: [] }).license_categories).toEqual([]);
  });

  test('anything else is VALIDATION_INVALID_ENUM', () => {
    expect(rejection(driverCreateBody, { ...valid, license_categories: ['B', 'automobile'] })).toMatchObject({
      code: 'VALIDATION_INVALID_ENUM',
      details: [{ field: 'license_categories.1', reason: 'invalid_enum' }],
    });
    expect(rejection(driverCreateBody, { ...valid, license_categories: 'B' }).code).toBe('VALIDATION_FAILED');
  });
});

describe('driverUpdateBody', () => {
  test('any non-empty subset; user_id cannot change', () => {
    expect(parseInput(driverUpdateBody, { license_categories: [] })).toEqual({ license_categories: [] });
    expect(rejection(driverUpdateBody, {}).details).toEqual([{ reason: 'empty_update' }]);
    expect(rejection(driverUpdateBody, { user_id: UUID }).details).toContainEqual({ field: 'user_id', reason: 'not_writable' });
  });
});

describe('driverListQuery', () => {
  test('defaults and a valid expiry filter', () => {
    expect(parseInput(driverListQuery, { license_expiring_before: '2026-12-31' })).toEqual({
      page: 1,
      page_size: 25,
      license_expiring_before: '2026-12-31',
      sort_by: 'license_number',
      sort_order: 'asc',
    });
  });

  test('rejects a malformed date, status or sort column', () => {
    expect(rejection(driverListQuery, { license_expiring_before: 'tomorrow' }).code).toBe('VALIDATION_FAILED');
    expect(rejection(driverListQuery, { status: 'deleted' }).code).toBe('VALIDATION_INVALID_ENUM');
    expect(rejection(driverListQuery, { sort_by: 'email' }).code).toBe('VALIDATION_INVALID_ENUM');
    expect(parseInput(driverListQuery, { sort_by: 'full_name' }).sort_by).toBe('full_name');
  });
});
