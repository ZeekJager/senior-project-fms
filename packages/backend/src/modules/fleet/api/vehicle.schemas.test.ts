import { describe, expect, test } from 'vitest';
import { AppError } from '../../../shared/errors/app-error';
import { parseInput } from '../../../shared/http/validate';
import { vehicleCreateBody, vehicleListQuery, vehicleUpdateBody } from './vehicle.schemas';

const DEPOT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const valid = {
  registration_number: 'AA 3-12345',
  make: 'Isuzu',
  model: 'FSR',
  vehicle_type: 'truck',
  fuel_type: 'diesel',
  fuel_efficiency_ml_per_km: 320,
  depot_id: DEPOT,
};

function rejection(schema: Parameters<typeof parseInput>[0], input: unknown): AppError {
  try {
    parseInput(schema, input);
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected the input to be rejected');
}

describe('vehicleCreateBody', () => {
  test('normalizes the registration number and VIN', () => {
    const out = parseInput(vehicleCreateBody, { ...valid, registration_number: '  aa   3-12345 ', vin: ' 1hgcm82633a004352 ' });
    expect(out.registration_number).toBe('AA 3-12345');
    expect(out.vin).toBe('1HGCM82633A004352');
  });

  test('fuel efficiency is required unless electric', () => {
    const withoutEfficiency = { ...valid, fuel_efficiency_ml_per_km: undefined };
    expect(rejection(vehicleCreateBody, withoutEfficiency)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'fuel_efficiency_ml_per_km', reason: 'required' }],
    });
    expect(() => parseInput(vehicleCreateBody, { ...withoutEfficiency, fuel_type: 'electric' })).not.toThrow();
    expect(rejection(vehicleCreateBody, { ...valid, fuel_efficiency_ml_per_km: null }).code).toBe('VALIDATION_FAILED');
  });

  test('a fractional fuel efficiency is a float in a fuel path', () => {
    expect(rejection(vehicleCreateBody, { ...valid, fuel_efficiency_ml_per_km: 320.5 }).code).toBe('VALIDATION_FLOAT_IN_MONEY_PATH');
  });

  test.each([0, -5, 100_001])('a fuel efficiency of %d is out of range', (n) => {
    expect(rejection(vehicleCreateBody, { ...valid, fuel_efficiency_ml_per_km: n }).details).toEqual([
      { field: 'fuel_efficiency_ml_per_km', reason: 'out_of_range' },
    ]);
  });

  test('odometer: not negative, at most one decimal', () => {
    expect(parseInput(vehicleCreateBody, { ...valid, odometer_km: 128450.5 }).odometer_km).toBe(128450.5);
    expect(rejection(vehicleCreateBody, { ...valid, odometer_km: -1 }).code).toBe('VALIDATION_FAILED');
    expect(rejection(vehicleCreateBody, { ...valid, odometer_km: 0.1 + 0.2 }).details).toEqual([
      { field: 'odometer_km', reason: 'too_many_decimals' },
    ]);
  });

  test.each([
    ['registration_number', ''],
    ['registration_number', 'AA/123'],
    ['vin', 'IOQ1234567890ABCD'],
    ['vin', 'SHORT'],
    ['year', 1899],
    ['year', new Date().getUTCFullYear() + 2],
    ['depot_id', 'not-a-uuid'],
    ['make', ''],
  ])('rejects %s = %j', (field, value) => {
    const err = rejection(vehicleCreateBody, { ...valid, [field]: value });
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details?.map((d) => d.field)).toContain(field);
  });

  test('an unknown enum value is VALIDATION_INVALID_ENUM', () => {
    expect(rejection(vehicleCreateBody, { ...valid, fuel_type: 'kerosene' })).toMatchObject({
      code: 'VALIDATION_INVALID_ENUM',
      details: [{ field: 'fuel_type', reason: 'invalid_enum' }],
    });
  });

  test('only documented writable fields are accepted', () => {
    expect(rejection(vehicleCreateBody, { ...valid, status: 'active', id: DEPOT }).details).toEqual(
      expect.arrayContaining([
        { field: 'status', reason: 'not_writable' },
        { field: 'id', reason: 'not_writable' },
      ]),
    );
  });
});

describe('vehicleUpdateBody', () => {
  test('any subset of the writable fields, but not none', () => {
    expect(parseInput(vehicleUpdateBody, { model: 'FVR' })).toEqual({ model: 'FVR' });
    expect(parseInput(vehicleUpdateBody, { fuel_efficiency_ml_per_km: null })).toEqual({ fuel_efficiency_ml_per_km: null });
    expect(rejection(vehicleUpdateBody, {}).details).toEqual([{ reason: 'empty_update' }]);
    expect(rejection(vehicleUpdateBody, { maintenance_flag: false }).details).toContainEqual({ field: 'maintenance_flag', reason: 'not_writable' });
  });
});

describe('vehicleListQuery', () => {
  test('defaults: first page of 25, by registration number', () => {
    expect(parseInput(vehicleListQuery, {})).toEqual({ page: 1, page_size: 25, sort_by: 'registration_number', sort_order: 'asc' });
  });

  test('parses query-string values and caps the page size', () => {
    expect(parseInput(vehicleListQuery, { page: '3', page_size: '1000', maintenance_flag: 'false', search: '  hilux ' })).toMatchObject({
      page: 3,
      page_size: 100,
      maintenance_flag: false,
      search: 'hilux',
    });
    expect(parseInput(vehicleListQuery, { search: '   ' }).search).toBeUndefined();
  });

  test('rejects a bad page, flag or sort column', () => {
    expect(rejection(vehicleListQuery, { page: '0' }).code).toBe('VALIDATION_FAILED');
    expect(rejection(vehicleListQuery, { maintenance_flag: 'yes' }).code).toBe('VALIDATION_INVALID_ENUM');
    expect(rejection(vehicleListQuery, { sort_by: 'v.id; DROP TABLE x' }).code).toBe('VALIDATION_INVALID_ENUM');
  });
});
