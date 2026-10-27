import { describe, expect, test } from 'vitest';
import { CATEGORY_FOR, SERVICE_SCHEDULE } from './catalog';
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

  test('a completed repair reads the odometer the vehicle had that day (a meter reading, FMS-126)', () => {
    const done = budget.maintenance.filter((m) => m.completed_at !== null);
    expect(done.length).toBeGreaterThan(0);
    for (const m of done) {
      const at = Date.parse(m.completed_at!);
      const logs = budget.fuelLogs.filter((f) => f.vehicle === m.vehicle);
      // Fuel logs are written up to 50 minutes before their trip ends, with the odometer after it.
      const before = logs.filter((f) => Date.parse(f.recorded_at) < at - 3_600_000).map((f) => f.odometer_km);
      const after = logs.filter((f) => Date.parse(f.recorded_at) > at).map((f) => f.odometer_km);
      expect(m.odometer_km).toBeGreaterThanOrEqual(Math.max(0, ...before));
      expect(m.odometer_km).toBeLessThanOrEqual(Math.min(budget.vehicles[m.vehicle].odometer_km, ...after));
    }
  });

  test('every vehicle joined the fleet years ago, and has kept up its service since (FMS-55)', () => {
    const DAY = 86_400_000;
    const anchor = anchorMidnight(ANCHOR);
    const done = budget.maintenance.filter((m) => m.completed_at !== null);
    const history = done.filter((m) => SERVICE_SCHEDULE.some((s) => s.description === m.description));
    budget.vehicles.forEach((v, i) => {
      const registered = Date.parse(v.registered_at);
      expect(registered).toBeGreaterThanOrEqual(anchorMidnight(`${v.year}-01-01`));
      expect(registered).toBeLessThanOrEqual(anchor - 60 * DAY);
      // No work, history or otherwise, before the vehicle joined the fleet.
      for (const m of done.filter((h) => h.vehicle === i)) {
        expect(Date.parse(m.completed_at!)).toBeGreaterThan(registered);
        expect(Date.parse(m.completed_at!)).toBeLessThan(anchor);
      }
    });
    // Every item the model reads is renewed on most vehicles; most combustion vehicles were serviced within 4 months.
    for (const item of ['engine_oil', 'air_filter', 'fuel_filter', 'coolant', 'brake_pads', 'brake_fluid', 'clutch_fluid', 'tyres', 'battery', 'gearbox_oil', 'belts']) {
      const renewed = new Set(history.filter((m) => m.parts.some((u) => budget.parts[u.part].service_item === item)).map((m) => m.vehicle));
      const eligible = budget.vehicles.filter((v) => v.fuel_type !== 'electric' || !['engine_oil', 'air_filter', 'fuel_filter', 'gearbox_oil', 'clutch_fluid', 'belts'].includes(item));
      expect(renewed.size / eligible.length, item).toBeGreaterThan(0.6);
    }
    const combustion = budget.vehicles.map((v, i) => ({ v, i })).filter(({ v }) => v.fuel_type !== 'electric');
    const serviced = combustion.filter(({ i }) => history.some((m) => m.vehicle === i && m.description.startsWith('Scheduled service') && Date.parse(m.completed_at!) > anchor - 120 * DAY));
    expect(serviced.length / combustion.length).toBeGreaterThan(0.8);
    expect(serviced.length).toBeLessThan(combustion.length);
  });

  test("each vehicle's repairs read an odometer that only goes up over time (none is a suspect reading)", () => {
    const done = budget.maintenance.filter((m) => m.completed_at !== null).sort((a, b) => a.completed_at!.localeCompare(b.completed_at!));
    const last = new Map<number, number>();
    for (const m of done) {
      expect(m.odometer_km, budget.vehicles[m.vehicle].registration_number).toBeGreaterThanOrEqual(last.get(m.vehicle) ?? 0);
      last.set(m.vehicle, m.odometer_km);
    }
  });

  test('the opening stock covers every repair, leaving the low and out-of-stock parts as drawn', () => {
    const used = new Map<number, number>();
    for (const m of budget.maintenance) for (const u of m.parts) used.set(u.part, (used.get(u.part) ?? 0) + u.quantity);
    budget.parts.forEach((p, i) => expect(p.stock_quantity - (used.get(i) ?? 0), p.part_number).toBeGreaterThanOrEqual(0));
    expect(budget.parts.filter((p) => p.service_item !== null)).toHaveLength(14);
    const left = (number: string) => budget.parts.find((p) => p.part_number === number)!.stock_quantity;
    expect([left('WPR-BLD-24'), left('LMP-HDL-H4')]).toEqual([3, 0]);
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
