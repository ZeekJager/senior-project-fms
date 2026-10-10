import { describe, expect, test } from 'vitest';
import { CATEGORY_FOR } from './catalog';
import { assertNotProduction } from './guard';
import { anchorMidnight, buildPlan } from './plan';

const ANCHOR = '2026-10-01';

describe('buildPlan', () => {
  test('the same seed and anchor give the same plan; another seed gives another', () => {
    expect(buildPlan('small', 42, ANCHOR)).toEqual(buildPlan('small', 42, ANCHOR));
    expect(buildPlan('small', 43, ANCHOR).vehicles).not.toEqual(buildPlan('small', 42, ANCHOR).vehicles);
  });

  const budget = buildPlan('budget', 20261007, ANCHOR);

  test('the budget profile is 200 vehicles (some electric), 300 drivers and 1,000 trips', () => {
    expect(budget.vehicles).toHaveLength(200);
    expect(budget.drivers).toHaveLength(300);
    expect(budget.trips).toHaveLength(1000);
    expect(budget.vehicles.filter((v) => v.fuel_type === 'electric').length).toBeGreaterThan(0);
    expect(budget.vehicles.filter((v) => v.fuel_type === 'electric').every((v) => v.fuel_efficiency_ml_per_km === null)).toBe(true);
  });

  test('every role, every trip status, routes, fuel logs and maintenance history are there', () => {
    expect(new Set([...budget.staff.map((s) => s.role), 'driver']).size).toBe(9);
    expect(new Set(budget.trips.map((t) => t.status))).toEqual(new Set(['draft', 'scheduled', 'assigned', 'en_route', 'completed', 'cancelled']));
    expect(budget.routes.length).toBeGreaterThan(0);
    expect(budget.fuelLogs.length).toBeGreaterThan(400);
    expect(budget.maintenance.some((m) => m.status === 'completed')).toBe(true);
  });

  test('unique keys are unique', () => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    expect(unique([...budget.staff, ...budget.drivers].map((p) => p.email))).toBe(true);
    expect(unique(budget.vehicles.map((v) => v.registration_number))).toBe(true);
    expect(unique(budget.vehicles.map((v) => v.vin))).toBe(true);
    expect(unique(budget.drivers.map((d) => d.license_number))).toBe(true);
  });

  test('crewed trips respect the rules the database and API enforce', () => {
    const windows = new Map<string, [number, number][]>();
    for (const t of budget.trips) {
      const crewed = ['assigned', 'en_route', 'completed'].includes(t.status);
      if (!crewed) continue;
      expect(t.driver).not.toBeNull();
      expect(t.vehicle).not.toBeNull();
      const driver = budget.drivers[t.driver!];
      const vehicle = budget.vehicles[t.vehicle!];
      expect(driver.depot).toBe(vehicle.depot);
      expect(driver.license_categories).toContain(CATEGORY_FOR[vehicle.vehicle_type]);
      expect(anchorMidnight(driver.license_expiry)).toBeGreaterThan(Date.parse(t.scheduled_end!));
      const span: [number, number] = [Date.parse(t.scheduled_start!), Date.parse(t.scheduled_end!)];
      for (const key of [`d${t.driver}`, `v${t.vehicle}`]) {
        for (const [s, e] of windows.get(key) ?? []) expect(span[0] >= e || span[1] <= s, `${key} double-booked`).toBe(true);
        windows.set(key, [...(windows.get(key) ?? []), span]);
      }
    }
  });

  test('each vehicle’s fuel-log odometer only goes up and ends at the vehicle’s odometer', () => {
    const last = new Map<number, number>();
    for (const f of [...budget.fuelLogs].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))) {
      expect(f.odometer_km).toBeGreaterThanOrEqual(last.get(f.vehicle) ?? 0);
      last.set(f.vehicle, f.odometer_km);
      expect(f.odometer_km).toBeLessThanOrEqual(budget.vehicles[f.vehicle].odometer_km);
      expect(Number.isInteger(f.quantity_ml) && Number.isInteger(f.total_cost_cents)).toBe(true);
    }
  });

  test('nothing the API would refuse: hire dates and attendance not after the anchor', () => {
    expect(budget.drivers.every((d) => d.hire_date <= ANCHOR)).toBe(true);
    expect(budget.attendance.every((a) => a.date <= ANCHOR)).toBe(true);
  });
});

describe('assertNotProduction', () => {
  test('refuses NODE_ENV=production in any case and spacing; allows the rest', () => {
    for (const env of ['production', 'Production', ' production ']) expect(() => assertNotProduction({ NODE_ENV: env })).toThrow(/Refusing to seed/);
    for (const env of [undefined, 'development', 'test']) expect(() => assertNotProduction({ NODE_ENV: env })).not.toThrow();
  });
});
