import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseError } from 'pg';
import { AppError } from './app-error';
import { errorBody, toAppError } from './to-app-error';

function pgError(code: string, fields: Partial<DatabaseError> = {}, message = 'db error'): DatabaseError {
  const err = new DatabaseError(message, 0, 'error');
  return Object.assign(err, { code, ...fields });
}

test('AppError passes through unchanged', () => {
  const err = new AppError(409, 'CONFLICT_VEHICLE_IN_USE', 'Vehicle is on an active trip.');
  assert.equal(toAppError(err), err);
});

test('known unique constraints map to their contract codes, without leaking values', () => {
  const err = toAppError(pgError('23505', { constraint: 'uq_fleet_vehicle_registration', detail: 'Key (registration_number)=(AA-12345) already exists.' }));
  assert.equal(err.status, 409);
  assert.equal(err.code, 'CONFLICT_DUPLICATE_PLATE');
  assert.deepEqual(err.details, [{ field: 'registration_number', reason: 'already_exists' }]);
  assert.ok(!JSON.stringify(err).includes('AA-12345'));
  assert.equal(toAppError(pgError('23505', { constraint: 'drivers_license_number_key' })).code, 'CONFLICT_DUPLICATE_LICENSE');
  assert.equal(toAppError(pgError('23505', { constraint: 'driver_attendance_driver_id_attendance_date_key' })).code, 'CONFLICT_ATTENDANCE_DUPLICATE');
});

test('other unique violations fall back to CONFLICT_DUPLICATE with every key column', () => {
  const err = toAppError(pgError('23505', { constraint: 'something_else', detail: 'Key (user_id, idempotency_key)=(1, k) already exists.' }));
  assert.equal(err.code, 'CONFLICT_DUPLICATE');
  assert.deepEqual(err.details?.map((d) => d.field), ['user_id', 'idempotency_key']);
});

test('trip overlap exclusion constraints map to overlap codes', () => {
  assert.equal(toAppError(pgError('23P01', { constraint: 'ex_trip_driver_overlap' })).code, 'CONFLICT_DRIVER_OVERLAP');
  assert.equal(toAppError(pgError('23P01', { constraint: 'ex_trip_vehicle_overlap' })).code, 'CONFLICT_VEHICLE_OVERLAP');
});

test('check, not-null, bad-format and missing-reference errors are 400 VALIDATION_FAILED', () => {
  const check = toAppError(pgError('23514', { constraint: 'chk_document_size' }));
  assert.deepEqual([check.status, check.code], [400, 'VALIDATION_FAILED']);
  assert.deepEqual(toAppError(pgError('23502', { column: 'location' })).details, [{ field: 'location', reason: 'required' }]);
  assert.equal(toAppError(pgError('22P02')).status, 400);
  const fk = toAppError(pgError('23503', { detail: 'Key (depot_id)=(999) is not present in table "depots".' }, 'insert or update on table "vehicles" violates foreign key constraint "x"'));
  assert.deepEqual([fk.status, fk.details?.[0].field], [400, 'depot_id']);
});

test('unmapped database errors and unknown errors become a generic 500', () => {
  for (const err of [pgError('53300'), new Error('connection string with password=hunter2'), 'boom', null]) {
    const appErr = toAppError(err);
    assert.deepEqual([appErr.status, appErr.code], [500, 'INTERNAL_SERVER_ERROR']);
    assert.equal(appErr.message, 'An unexpected error occurred.');
  }
});

test('body-parser errors map to 400 and 413', () => {
  assert.equal(toAppError(Object.assign(new SyntaxError('x'), { type: 'entity.parse.failed' })).code, 'VALIDATION_FAILED');
  const big = toAppError(Object.assign(new Error('x'), { type: 'entity.too.large' }));
  assert.deepEqual([big.status, big.code], [413, 'PAYLOAD_TOO_LARGE']);
});

test('errorBody follows the contract envelope', () => {
  const body = errorBody(new AppError(404, 'NOT_FOUND', 'Missing.'), 'req-1');
  assert.deepEqual(Object.keys(body.error), ['code', 'message']);
  assert.equal(body.meta.request_id, 'req-1');
  assert.ok(!Number.isNaN(Date.parse(body.meta.timestamp)));
  assert.equal(errorBody(new AppError(500, 'INTERNAL_SERVER_ERROR', 'x'), 'r', 'stack here').error.stack, 'stack here');
});
