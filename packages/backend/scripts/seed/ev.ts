import { SIM_STATIONS, chargeCostCents, chargeEnergyKwh, chargeMinutes, evProfileOf, type EvProfile, type SimStation } from '../simulator/ev-charging';
import { anchorMidnight, type SeedPlan } from './plan';
import { Rng } from './random';

/**
 * EV synthetic data (FMS-97, decision D-06, docs/ev.md#synthetic-data): 90 days of battery readings and charging
 * sessions for the seeded fleet's electric vehicles, ending at the anchor. Pure, like buildPlan: the same plan, seed
 * and anchor give the same data, with a generator of its own, so the rest of the seed is unchanged by it.
 *
 * Each EV follows one scenario (the first four EVs one each, in this order, so every profile has them all; the
 * rest mostly normal):
 * - `fast_degradation`: its battery health falls about ten points over the 90 days, against about one normally.
 * - `low_charge`: driven hard and charged late, so its state of charge falls below 15% again and again.
 * - `unreliable_charging`: three evenings in ten its session fails (the charger, the connector), and it retries elsewhere:
 *   about a quarter of its sessions fail.
 * - `normal`: charged most evenings at its home station; about 3% of sessions fail.
 */

export const EV_SCENARIOS = ['fast_degradation', 'low_charge', 'unreliable_charging', 'normal'] as const;
export type EvScenario = (typeof EV_SCENARIOS)[number];

/** The days of data before the anchor. */
export const EV_HISTORY_DAYS = 90;
/** Readings a day, local time (Addis Ababa): before the shift, midday on duty, after the shift. */
export const READING_HOURS = [6, 12, 17] as const;
/** A state of charge below this is a low-charge event (FMS-98's alert builds on it). */
export const LOW_CHARGE_PCT = 15;

export interface PlannedEvVehicle {
  /** Index into plan.vehicles. */
  vehicle: number;
  scenario: EvScenario;
  /** Index into SIM_STATIONS: where it usually charges. */
  homeStation: number;
  /** Its model's usable capacity when new, kWh: its battery spec (FMS-98). */
  capacityKwh: number;
}

export interface PlannedBatteryLog {
  vehicle: number;
  recorded_at: string;
  state_of_charge: number;
  battery_health: number;
  battery_temperature_c: number;
  voltage_v: number;
  current_a: number;
  estimated_range_km: number;
  /** Since the previous reading; null when the vehicle has not moved (it charged overnight). */
  energy_wh_per_km: number | null;
}

export interface PlannedChargingSession {
  vehicle: number;
  /** Index into SIM_STATIONS. */
  station: number;
  /** The simulated network's id for it: the de-duplication key a provider's session has. */
  external_session_id: string;
  status: 'completed' | 'failed';
  started_at: string;
  ended_at: string;
  start_soc: number;
  end_soc: number;
  energy_kwh: number;
  cost_cents: number;
}

export interface EvPlan {
  vehicles: PlannedEvVehicle[];
  stations: readonly SimStation[];
  logs: PlannedBatteryLog[];
  sessions: PlannedChargingSession[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;
/** Addis Ababa is UTC+3 all year. */
const ADDIS_OFFSET = 3 * HOUR;
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const iso = (ms: number) => new Date(ms).toISOString();
/** A generator of its own, so adding EV data changes nothing else the seed draws. */
const EV_SALT = 0x45560097;

const HEALTH_LOSS_PER_DAY: Readonly<Record<EvScenario, [number, number]>> = {
  fast_degradation: [0.09, 0.13],
  low_charge: [0.008, 0.016],
  unreliable_charging: [0.004, 0.012],
  normal: [0.004, 0.012],
};
const FAILURE_SHARE: Readonly<Record<EvScenario, number>> = { fast_degradation: 0.03, low_charge: 0.03, unreliable_charging: 0.3, normal: 0.03 };
/** It charges in the evening when its state of charge is below this. */
const CHARGE_BELOW: Readonly<Record<EvScenario, number>> = { fast_degradation: 60, low_charge: 25, unreliable_charging: 60, normal: 60 };

/** Ambient temperature in Addis Ababa at a local hour, °C: cool mornings, warm afternoons. */
const ambient = (hour: number, rng: Rng) => (hour <= 7 ? 12 : hour <= 13 ? 22 : 24) + rng.between(-2.5, 2.5);

/** A heavy vehicle charges only at a station that can fill it overnight. */
const canUse = (profile: EvProfile, station: SimStation) => profile.capacityKwh <= 150 || station.power_kw >= 60;

export function buildEvPlan(plan: SeedPlan, days = EV_HISTORY_DAYS): EvPlan {
  const rng = new Rng((plan.seed ^ EV_SALT) >>> 0);
  const end = anchorMidnight(plan.anchor);
  const start = end - days * DAY;
  const vehicles: PlannedEvVehicle[] = [];
  const logs: PlannedBatteryLog[] = [];
  const sessions: PlannedChargingSession[] = [];

  const electric = plan.vehicles.map((v, i) => ({ v, i })).filter(({ v }) => v.fuel_type === 'electric');
  for (const [n, { v, i }] of electric.entries()) {
    const profile = evProfileOf(v.make, v.model);
    const scenario: EvScenario = n < EV_SCENARIOS.length ? EV_SCENARIOS[n] : rng.weighted({ normal: 7, fast_degradation: 1, low_charge: 1, unreliable_charging: 1 });
    const usable = SIM_STATIONS.map((s, k) => ({ s, k })).filter(({ s }) => canUse(profile, s));
    const homeStation = rng.pick(usable).k;
    vehicles.push({ vehicle: i, scenario, homeStation, capacityKwh: profile.capacityKwh });

    let health = round(scenario === 'fast_degradation' ? rng.between(93, 97) : rng.between(94, 99), 2);
    const loss = rng.between(...HEALTH_LOSS_PER_DAY[scenario]);
    let soc = rng.between(70, 95);
    let sessionNo = 0;
    let lastWhPerKm = profile.whPerKm;

    const reading = (at: number, hour: number, moved: boolean, kmSince: number, whPerKm: number) => {
      const measured = round(Math.min(100, health + rng.between(-0.15, 0.15)), 2);
      const kwhLeft = (soc / 100) * profile.capacityKwh * (measured / 100);
      logs.push({
        vehicle: i,
        recorded_at: iso(at),
        state_of_charge: round(soc, 1),
        battery_health: measured,
        battery_temperature_c: round(ambient(hour, rng) + (moved ? rng.between(3, 7) : 0), 1),
        voltage_v: round(profile.packVoltage * (0.86 + (0.14 * soc) / 100), 1),
        current_a: hour === 12 ? round(-(whPerKm * 35) / profile.packVoltage, 1) : 0,
        estimated_range_km: Math.round((kwhLeft * 1000) / whPerKm),
        energy_wh_per_km: moved && kmSince > 0 ? round(whPerKm, 1) : null,
      });
    };

    for (let d = 0; d < days; d++) {
      const midnight = start + d * DAY;
      const weekday = new Date(midnight + ADDIS_OFFSET).getUTCDay();
      const duty = weekday === 0 ? 0.3 : weekday === 6 ? 0.7 : 1;
      const km = rng.between(...profile.dailyKm) * duty * (scenario === 'low_charge' ? 1.25 : 1);
      // A worn battery and a heavy day both use more per km.
      const whPerKm = profile.whPerKm * rng.between(0.92, 1.12) * (1 + (100 - health) * 0.004);
      lastWhPerKm = whPerKm;

      // 06:00: parked since the evening's charge.
      reading(midnight + READING_HOURS[0] * HOUR, READING_HOURS[0], false, 0, lastWhPerKm);
      // The shift: 55% of the day's km by midday, the rest by 17:00. The driver stops before the battery is empty.
      for (const [h, share] of [[READING_HOURS[1], 0.55], [READING_HOURS[2], 0.45]] as const) {
        const want = km * share;
        const kwhPerPct = (profile.capacityKwh * (health / 100)) / 100;
        const pctUsed = Math.min((want * whPerKm) / 1000 / kwhPerPct, Math.max(0, soc - 3));
        soc -= pctUsed;
        reading(midnight + h * HOUR, h, true, (pctUsed * kwhPerPct * 1000) / whPerKm, whPerKm);
      }

      // The evening's charge.
      // A careful driver also charges when tomorrow's longest duty would not fit in what is left; low_charge does not.
      const longestDayPct = ((profile.dailyKm[1] * profile.whPerKm) / 1000 / (profile.capacityKwh * (health / 100))) * 100 * 1.15;
      const threshold = scenario === 'low_charge' ? CHARGE_BELOW[scenario] : Math.min(85, Math.max(CHARGE_BELOW[scenario], longestDayPct + LOW_CHARGE_PCT));
      const mustCharge = soc < LOW_CHARGE_PCT;
      const wants = soc < threshold && (scenario !== 'low_charge' || mustCharge || rng.chance(0.6));
      if (mustCharge || wants) {
        let at = midnight + rng.between(18.5, 20) * HOUR;
        let station = rng.chance(0.75) ? homeStation : rng.pick(usable).k;
        for (let attempt = 0; attempt < 2; attempt++) {
          const failed = attempt === 0 && rng.chance(FAILURE_SHARE[scenario]);
          const st = SIM_STATIONS[station];
          const full = st.power_kw >= 100 ? rng.between(80, 90) : rng.between(90, 100);
          const target = failed ? Math.min(100, soc + rng.between(0, 3)) : Math.max(full, Math.min(100, soc + 10));
          const energy = chargeEnergyKwh(profile, health, soc, target);
          const minutes = failed ? rng.int(3, 25) : chargeMinutes(profile, st, energy, target);
          sessionNo += 1;
          sessions.push({
            vehicle: i,
            station,
            external_session_id: `SIM-H-${String(i).padStart(3, '0')}-${String(sessionNo).padStart(3, '0')}`,
            status: failed ? 'failed' : 'completed',
            started_at: iso(Math.round(at / MINUTE) * MINUTE),
            ended_at: iso(Math.round((at + minutes * MINUTE) / MINUTE) * MINUTE),
            start_soc: round(soc, 1),
            end_soc: round(target, 1),
            energy_kwh: energy,
            cost_cents: chargeCostCents(st, energy),
          });
          soc = target;
          if (!failed) break;
          // Another station, 15 to 30 minutes later.
          at += (minutes + rng.int(15, 30)) * MINUTE;
          station = rng.pick(usable.filter(({ k }) => k !== station)).k;
        }
      }
      // Overnight: a little standby loss, and the battery ages.
      soc = Math.max(0, soc - rng.between(0.2, 0.8));
      health = Math.max(50, health - loss);
    }
  }
  return { vehicles, stations: SIM_STATIONS, logs, sessions };
}
