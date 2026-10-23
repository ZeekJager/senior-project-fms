import { describe, expect, test } from 'vitest';
import { CATEGORY_FOR } from './catalog';
import { assertNotProduction } from './guard';
import { sniffContentType } from '../../src/modules/fleet/domain/document';
import { placeholderPdf } from './pdf';
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

  test('corrective repairs under way or done say what failed, before they were finished (FMS-125)', () => {
    const corrective = budget.maintenance.filter((m) => m.maintenance_type === 'corrective' && m.status !== 'scheduled');
    expect(corrective.length).toBeGreaterThan(0);
    expect(corrective.every((m) => m.failures.length === 1)).toBe(true);
    expect(budget.maintenance.filter((m) => m.maintenance_type !== 'corrective').every((m) => m.failures.length === 0)).toBe(true);
    for (const m of corrective.filter((c) => c.completed_at)) expect(Date.parse(m.failures[0].occurred_at)).toBeLessThan(Date.parse(m.completed_at!));
    const failures = corrective.flatMap((m) => m.failures);
    expect(new Set(failures.map((f) => f.component)).size).toBeGreaterThan(4);
    expect(failures.some((f) => f.unplanned) && failures.some((f) => !f.unplanned)).toBe(true);
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

  test('every vehicle has insurance and registration; some expire within 30 days and some within 7', () => {
    const daysLeft = (expires: string) => Math.round((anchorMidnight(expires) - anchorMidnight(ANCHOR)) / 86_400_000);
    for (const [name, plan] of [
      ['budget', budget],
      ['small', buildPlan('small', 20261007, ANCHOR)],
    ] as const) {
      expect(plan.documents, name).toHaveLength(plan.vehicles.length * 2);
      plan.vehicles.forEach((_, i) => {
        expect(plan.documents.filter((d) => d.vehicle === i).map((d) => d.document_type).sort()).toEqual(['insurance', 'registration']);
      });
      const days = plan.documents.map((d) => daysLeft(d.expires_on));
      expect(days.every((n) => n >= 0 && n <= 365), `${name}: none expired, none beyond a year`).toBe(true);
      expect(days.some((n) => n <= 7), `${name}: a red one`).toBe(true);
      expect(days.some((n) => n > 7 && n <= 30), `${name}: an amber one`).toBe(true);
      expect(days.filter((n) => n > 30).length / days.length, `${name}: most valid for months`).toBeGreaterThan(0.75);
    }
  });
});

describe('placeholderPdf', () => {
  test('is a PDF the upload accepts, and the same text gives the same bytes', () => {
    const pdf = placeholderPdf('Insurance certificate AA 3-10001 (demo), valid until 2026-10-05');
    expect(sniffContentType(pdf)).toBe('application/pdf');
    expect(pdf.toString('latin1')).toContain('\\(demo\\)');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(placeholderPdf('Insurance certificate AA 3-10001 (demo), valid until 2026-10-05').equals(pdf)).toBe(true);
  });
});

describe('assertNotProduction', () => {
  test('refuses NODE_ENV=production in any case and spacing; allows the rest', () => {
    for (const env of ['production', 'Production', ' production ']) expect(() => assertNotProduction({ NODE_ENV: env })).toThrow(/Refusing to seed/);
    for (const env of [undefined, 'development', 'test']) expect(() => assertNotProduction({ NODE_ENV: env })).not.toThrow();
  });
});
