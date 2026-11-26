import { describe, expect, test } from 'vitest';
import { closeSchema, CROSS_CUTTING_STATUSES, operationFor, strictResponseProblems } from '../support/openapi';

// FMS-100: the checks the contract hook (test/support/contract-hook.ts) makes of every response the integration tests
// receive. Here on bodies made up for the purpose, so each rule is shown failing and passing.

const vehicle = {
  id: '00000000-0000-4000-8000-000000000001',
  registration_number: 'AA 3-20001',
  vin: null,
  make: 'Isuzu',
  model: 'FSR',
  year: 2018,
  vehicle_type: 'truck',
  fuel_type: 'diesel',
  fuel_efficiency_ml_per_km: 325,
  tank_capacity_ml: 200_000,
  payload_capacity_kg: null,
  body: null,
  seats: null,
  gross_weight_kg: null,
  status: 'active',
  maintenance_flag: false,
  health_score: null,
  health_score_updated_at: null,
  depot_id: '11111111-1111-4111-8111-111111111111',
  odometer_km: 87_000,
  current_trip: null,
  version: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('the API contract (FMS-100)', () => {
  test('a response field the spec does not name fails', () => {
    const ok = strictResponseProblems('/vehicles/{vehicle_id}', 'get', 200, { data: vehicle, meta: { request_id: 'r' } });
    // Only fields the spec names: whatever else the schema asks of them is checked as usual.
    expect(ok === null || !ok.includes('unevaluatedProperty')).toBe(true);
    const extra = strictResponseProblems('/vehicles/{vehicle_id}', 'get', 200, { data: { ...vehicle, secret_field: 1 }, meta: { request_id: 'r' } });
    expect(extra).toContain('secret_field');
    expect(extra).toContain('unevaluatedProperties');
  });

  test('a status the operation does not list fails, unless every route may answer it', () => {
    expect(strictResponseProblems('/vehicles', 'get', 418, {})).toBe('GET /vehicles lists no 418 response');
    expect(CROSS_CUTTING_STATUSES).toEqual([401, 403, 413, 429, 500, 503]);
    // A rate limit on a route that does not list 429: still the error envelope, or it fails.
    expect(strictResponseProblems('/vehicles', 'get', 429, { error: { code: 'RATE_LIMITED', message: 'Slow down.' }, meta: { request_id: '00000000-0000-4000-8000-0000000000aa' } })).toBeNull();
    expect(strictResponseProblems('/vehicles', 'get', 429, { slow: 'down' })).not.toBeNull();
  });

  test('objects the spec describes field by field are closed; free-form maps and composition members are not', () => {
    expect(closeSchema({ type: 'object', properties: { a: { type: 'string' } } })).toMatchObject({ unevaluatedProperties: false });
    expect(closeSchema({ type: 'object' })).not.toHaveProperty('unevaluatedProperties');
    expect(closeSchema({ type: 'object', additionalProperties: { type: 'integer' } })).not.toHaveProperty('unevaluatedProperties');
    const composed = closeSchema({ allOf: [{ type: 'object', properties: { a: {} } }, { type: 'object', properties: { b: {} } }] }) as Record<string, unknown>;
    expect(composed.unevaluatedProperties).toBe(false);
    expect((composed.allOf as Record<string, unknown>[]).every((m) => !('unevaluatedProperties' in m))).toBe(true);
  });

  test('a request is matched to its operation by method and path, literal segments first', () => {
    expect(operationFor('GET', 'http://127.0.0.1:1234/api/v1/vehicles/00000000-0000-4000-8000-000000000001?x=1')?.path).toBe('/vehicles/{vehicle_id}');
    // A path no operation has: an unknown sub-resource of a known one (not a real route, so the spec never gains it).
    expect(operationFor('GET', '/api/v1/vehicles/00000000-0000-4000-8000-000000000001/no-such-subresource')).toBeNull();
    expect(operationFor('GET', '/health/ready')?.path).toBe('/health/ready');
    expect(operationFor('GET', '/api/v1/health/ready')).toBeNull();
    expect(operationFor('DELETE', '/api/v1/auth/me')).toBeNull();
  });
});
