import { describe, expect, test } from 'vitest';
import { evChargingDelivery } from '../../src/modules/integration/domain/ev-charging-schema';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '../../src/modules/integration/domain/webhook-signature';
import { EV_PROFILES, SIM_STATIONS, chargeEnergyKwh, evDelivery, evProfileOf, signEvDelivery } from '../simulator/ev-charging';
import { EV_MODELS } from './catalog';
import { EV_HISTORY_DAYS, EV_SCENARIOS, LOW_CHARGE_PCT, READING_HOURS, buildEvPlan, type EvPlan } from './ev';
import { anchorMidnight, buildPlan } from './plan';

// FMS-97 (docs/ev.md#synthetic-data): the EV synthetic data, as plain data, and the simulated network's deliveries.

const ANCHOR = '2026-10-01';
const DAY = 86_400_000;
const small = buildPlan('small', 20261007, ANCHOR);
const budget = buildPlan('budget', 20261007, ANCHOR);
const smallEv = buildEvPlan(small);
const budgetEv = buildEvPlan(budget);

/** Least-squares slope of y over x. */
function slope(points: { x: number; y: number }[]): number {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const cov = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const varx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  return cov / varx;
}

/** Battery health per day of one vehicle, as a trend line's points. */
const healthTrend = (ev: EvPlan, vehicle: number) =>
  ev.logs.filter((l) => l.vehicle === vehicle).map((l) => ({ x: Date.parse(l.recorded_at) / DAY, y: l.battery_health }));

describe('EV synthetic data (FMS-97)', () => {
  test('the same seed and anchor give identical data; another seed gives other data', () => {
    expect(buildEvPlan(buildPlan('small', 42, ANCHOR))).toEqual(buildEvPlan(buildPlan('small', 42, ANCHOR)));
    expect(buildEvPlan(buildPlan('small', 43, ANCHOR)).logs).not.toEqual(buildEvPlan(buildPlan('small', 42, ANCHOR)).logs);
  });

  test('adding it changes nothing else the seed draws', () => {
    // buildEvPlan has its own generator: the seed plan is the same object either way.
    const before = JSON.stringify(buildPlan('small', 20261007, ANCHOR));
    buildEvPlan(small);
    expect(JSON.stringify(small)).toBe(before);
  });

  test('every seeded EV gets 90 days of readings, three a day, ending before the anchor', () => {
    for (const ev of [smallEv, budgetEv]) {
      const plan = ev === smallEv ? small : budget;
      const electric = plan.vehicles.map((v, i) => (v.fuel_type === 'electric' ? i : -1)).filter((i) => i >= 0);
      expect(electric.length).toBeGreaterThan(0);
      expect(ev.vehicles.map((v) => v.vehicle)).toEqual(electric);
      for (const i of electric) expect(ev.logs.filter((l) => l.vehicle === i)).toHaveLength(EV_HISTORY_DAYS * READING_HOURS.length);
      const times = ev.logs.map((l) => Date.parse(l.recorded_at));
      const end = anchorMidnight(ANCHOR);
      expect(Math.max(...times)).toBeLessThan(end);
      expect(Math.min(...times)).toBeGreaterThanOrEqual(end - EV_HISTORY_DAYS * DAY);
    }
  });

  test('readings are within the API’s ranges and describe the battery: SoC, health, temperature, energy per km', () => {
    for (const l of budgetEv.logs) {
      expect(l.state_of_charge).toBeGreaterThanOrEqual(0);
      expect(l.state_of_charge).toBeLessThanOrEqual(100);
      expect(l.battery_health).toBeGreaterThan(50);
      expect(l.battery_health).toBeLessThanOrEqual(100);
      expect(l.battery_temperature_c).toBeGreaterThan(-60);
      expect(l.battery_temperature_c).toBeLessThan(60);
      expect(l.estimated_range_km).toBeGreaterThanOrEqual(0);
      expect(l.estimated_range_km).toBeLessThanOrEqual(2000);
      if (l.energy_wh_per_km !== null) expect(l.energy_wh_per_km).toBeGreaterThan(100);
    }
    // Moving readings have energy per km; the 06:00 reading after the night's charge does not.
    expect(budgetEv.logs.filter((l) => l.energy_wh_per_km === null).length).toBeGreaterThan(0);
    expect(budgetEv.logs.filter((l) => l.energy_wh_per_km !== null).length).toBeGreaterThan(budgetEv.logs.length / 2);
  });

  test('every scenario is in every profile: the first four EVs take one each', () => {
    expect(small.vehicles.filter((v) => v.fuel_type === 'electric').length).toBeGreaterThanOrEqual(3);
    expect(smallEv.vehicles.map((v) => v.scenario)).toEqual(EV_SCENARIOS.slice(0, smallEv.vehicles.length));
    expect(new Set(budgetEv.vehicles.map((v) => v.scenario))).toEqual(new Set(EV_SCENARIOS));
  });

  test('the degradation scenario’s battery health falls fast; a normal battery’s barely moves', () => {
    const degrading = budgetEv.vehicles.filter((v) => v.scenario === 'fast_degradation');
    const normal = budgetEv.vehicles.filter((v) => v.scenario === 'normal');
    expect(degrading.length).toBeGreaterThan(0);
    expect(normal.length).toBeGreaterThan(0);
    for (const v of degrading) {
      expect(slope(healthTrend(budgetEv, v.vehicle))).toBeLessThan(-0.08);
      const logs = budgetEv.logs.filter((l) => l.vehicle === v.vehicle);
      expect(logs[0].battery_health - logs[logs.length - 1].battery_health).toBeGreaterThan(7);
    }
    for (const v of normal) expect(slope(healthTrend(budgetEv, v.vehicle))).toBeGreaterThan(-0.02);
  });

  test('the low-charge scenario falls below 15% again and again; a normal EV seldom does', () => {
    const lows = (vehicle: number) => budgetEv.logs.filter((l) => l.vehicle === vehicle && l.state_of_charge < LOW_CHARGE_PCT).length;
    for (const v of budgetEv.vehicles.filter((x) => x.scenario === 'low_charge')) expect(lows(v.vehicle)).toBeGreaterThanOrEqual(10);
    for (const v of budgetEv.vehicles.filter((x) => x.scenario === 'normal')) expect(lows(v.vehicle)).toBeLessThan(5);
  });

  test('sessions: failed ones (most on unreliable charging), retried elsewhere; none overlap; figures add up', () => {
    const failed = budgetEv.sessions.filter((s) => s.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    const unreliable = new Set(budgetEv.vehicles.filter((v) => v.scenario === 'unreliable_charging').map((v) => v.vehicle));
    const share = (vehicles: (n: number) => boolean) => {
      const list = budgetEv.sessions.filter((s) => vehicles(s.vehicle));
      return list.filter((s) => s.status === 'failed').length / list.length;
    };
    expect(share((v) => unreliable.has(v))).toBeGreaterThan(0.12);
    expect(share((v) => !unreliable.has(v))).toBeLessThan(0.08);
    expect(new Set(budgetEv.sessions.map((s) => s.external_session_id)).size).toBe(budgetEv.sessions.length);

    for (const v of budgetEv.vehicles) {
      const list = budgetEv.sessions.filter((s) => s.vehicle === v.vehicle);
      expect(list.length).toBeGreaterThan(10);
      for (const [k, s] of list.entries()) {
        expect(Date.parse(s.ended_at)).toBeGreaterThan(Date.parse(s.started_at));
        if (k > 0) expect(Date.parse(s.started_at)).toBeGreaterThan(Date.parse(list[k - 1].ended_at));
        expect(s.end_soc).toBeGreaterThanOrEqual(s.start_soc);
        expect(s.cost_cents).toBe(Math.round(s.energy_kwh * SIM_STATIONS[s.station].tariff_cents_per_kwh));
        // A failed session's next attempt is at another station.
        if (s.status === 'failed' && list[k + 1]) expect(list[k + 1].station).not.toBe(s.station);
      }
    }
    // A heavy vehicle only charges where it can fill up overnight.
    const buses = budget.vehicles.map((x, i) => (x.model === 'E12' ? i : -1)).filter((i) => i >= 0);
    for (const s of budgetEv.sessions.filter((x) => buses.includes(x.vehicle))) expect(SIM_STATIONS[s.station].power_kw).toBeGreaterThanOrEqual(60);
  });

  test('every EV model of the catalogue has a charging profile', () => {
    for (const m of EV_MODELS) expect(EV_PROFILES[`${m.make} ${m.model}`], m.model).toBeDefined();
    expect(evProfileOf('Unknown', 'EV')).toBe(EV_PROFILES['BYD e6']);
    // 18% to 80% of a new 71.7 kWh pack, 92% efficient.
    expect(chargeEnergyKwh(EV_PROFILES['BYD e6'], 100, 18, 80)).toBeCloseTo(48.32, 1);
  });
});

describe('the simulated network’s deliveries (FMS-97)', () => {
  const session = { session_id: 'sim-s-1', vehicle_id: '5d0a8b4e-6f9c-4b0e-9a37-2f1c3e4d5a6b', station_id: 'SIM-ST-01', start_soc: 20 };

  test('are in the FMS EV charging format, signed as a real provider signs', () => {
    const body = evDelivery('session_started', session, new Date('2026-11-26T15:00:00Z'), 'sim-e-1');
    expect(evChargingDelivery.parse(body)).toEqual(body);
    const signed = signEvDelivery('s'.repeat(32), body, Date.parse('2026-11-26T15:00:05Z'));
    expect(signed.raw).toBe(JSON.stringify(body));
    expect(signed.headers[TIMESTAMP_HEADER]).toBe(String(Date.parse('2026-11-26T15:00:05Z') / 1000));
    expect(signed.headers[SIGNATURE_HEADER]).toBe(signWebhook('s'.repeat(32), Date.parse('2026-11-26T15:00:05Z') / 1000, signed.raw));
  });

  test('a replay has a new event id unless one is given', () => {
    const a = evDelivery('session_started', session, new Date());
    const b = evDelivery('session_started', session, new Date());
    expect(a.event_id).not.toBe(b.event_id);
  });
});
