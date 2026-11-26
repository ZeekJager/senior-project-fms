import { randomUUID } from 'node:crypto';
// The pure parts only (not the modules' index files, which connect to the database), so the unit tests run without one.
import type { EvChargingDelivery, EvSessionKind } from '../../src/modules/integration/domain/ev-charging-schema';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '../../src/modules/integration/domain/webhook-signature';

/**
 * The simulated charging network (FMS-97, decision D-06): its EV profiles, its stations around Addis Ababa, and its
 * signed webhook deliveries in the FMS EV charging format. The generator (scripts/seed/ev.ts), the EV simulator
 * (scripts/simulate-ev.ts) and the tests share them. Every figure here is invented, and every record made from them
 * is marked synthetic.
 */

/** The simulated network's provider code (migration 084): POST /webhooks/ev/simulated. */
export const SIMULATED_PROVIDER = 'simulated';

/** How an EV model charges and uses its battery: the generator's physics. */
export interface EvProfile {
  /** Usable battery capacity when new, kWh. */
  capacityKwh: number;
  /** Typical consumption, Wh per km, on Addis Ababa's roads. */
  whPerKm: number;
  /** The most the vehicle takes from a DC charger, kW (an AC charger gives at most its own power). */
  maxChargeKw: number;
  /** Pack voltage at full charge, V. */
  packVoltage: number;
  /** Typical distance a working day, km (the vehicle's duty). */
  dailyKm: [number, number];
}

/** By make and model, as in the seed catalogue's EV_MODELS. */
export const EV_PROFILES: Readonly<Record<string, EvProfile>> = {
  'BYD e6': { capacityKwh: 71.7, whPerKm: 180, maxChargeKw: 60, packVoltage: 403, dailyKm: [90, 190] },
  'BYD T3': { capacityKwh: 50.3, whPerKm: 205, maxChargeKw: 40, packVoltage: 384, dailyKm: [70, 150] },
  'Volkswagen ID.4': { capacityKwh: 77, whPerKm: 175, maxChargeKw: 125, packVoltage: 396, dailyKm: [80, 170] },
  'Yutong E12': { capacityKwh: 350, whPerKm: 1000, maxChargeKw: 150, packVoltage: 579, dailyKm: [100, 170] },
};

/** A vehicle the catalogue does not know charges like a small car. */
export const DEFAULT_EV_PROFILE: EvProfile = EV_PROFILES['BYD e6'];

export const evProfileOf = (make: string, model: string): EvProfile => EV_PROFILES[`${make} ${model}`] ?? DEFAULT_EV_PROFILE;

export interface SimStation {
  external_station_id: string;
  name: string;
  latitude: number;
  longitude: number;
  connector_type: 'CCS2' | 'Type 2' | 'GB/T';
  power_kw: number;
  /** What a kWh costs there, in cents (ETB): public DC charging costs more than an AC post. */
  tariff_cents_per_kwh: number;
}

/** The simulated network's stations, at real places around Addis Ababa (the names are invented). */
export const SIM_STATIONS: readonly SimStation[] = [
  { external_station_id: 'SIM-ST-01', name: 'Bole Airport charging hub', latitude: 8.9897, longitude: 38.7887, connector_type: 'CCS2', power_kw: 120, tariff_cents_per_kwh: 1450 },
  { external_station_id: 'SIM-ST-02', name: 'Megenagna EV point', latitude: 9.0201, longitude: 38.8018, connector_type: 'CCS2', power_kw: 60, tariff_cents_per_kwh: 1300 },
  { external_station_id: 'SIM-ST-03', name: 'Piassa charging bay', latitude: 9.0368, longitude: 38.7524, connector_type: 'Type 2', power_kw: 22, tariff_cents_per_kwh: 950 },
  { external_station_id: 'SIM-ST-04', name: 'Mexico Square chargers', latitude: 9.0103, longitude: 38.7445, connector_type: 'GB/T', power_kw: 60, tariff_cents_per_kwh: 1250 },
  { external_station_id: 'SIM-ST-05', name: 'Kality depot chargers', latitude: 8.9285, longitude: 38.7676, connector_type: 'GB/T', power_kw: 150, tariff_cents_per_kwh: 1100 },
  { external_station_id: 'SIM-ST-06', name: 'CMC EV station', latitude: 9.0226, longitude: 38.8435, connector_type: 'Type 2', power_kw: 22, tariff_cents_per_kwh: 900 },
  { external_station_id: 'SIM-ST-07', name: 'Sarbet charging point', latitude: 8.9962, longitude: 38.7351, connector_type: 'CCS2', power_kw: 60, tariff_cents_per_kwh: 1300 },
  { external_station_id: 'SIM-ST-08', name: 'Ayat fast chargers', latitude: 9.0352, longitude: 38.8770, connector_type: 'CCS2', power_kw: 120, tariff_cents_per_kwh: 1450 },
];

/** A session as the provider reports it in a delivery. */
export type SimSession = EvChargingDelivery['session'];

/** One delivery's body. `eventId` defaults to a fresh one: a replay of the same news under a new id. */
export function evDelivery(type: EvSessionKind, session: SimSession, occurredAt: Date, eventId = `sim-${randomUUID()}`): EvChargingDelivery {
  return { event_id: eventId, type, occurred_at: occurredAt.toISOString(), session };
}

/** A signed webhook delivery, ready to POST to /webhooks/ev/{code}. */
export interface SignedEvDelivery {
  raw: string;
  headers: Record<string, string>;
}

/** Signs a delivery with the provider's secret, as a real provider signs it (docs/integrations.md#webhooks). */
export function signEvDelivery(secret: string, body: EvChargingDelivery, nowMs = Date.now()): SignedEvDelivery {
  const raw = JSON.stringify(body);
  const ts = Math.floor(nowMs / 1000);
  return { raw, headers: { 'content-type': 'application/json', [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signWebhook(secret, ts, raw) } };
}

/** The energy a charge from `fromSoc` to `toSoc` takes from the charger, kWh: the usable capacity left, and 92% efficient. */
export function chargeEnergyKwh(profile: EvProfile, healthPct: number, fromSoc: number, toSoc: number): number {
  return Math.round((((toSoc - fromSoc) / 100) * profile.capacityKwh * (healthPct / 100)) / 0.92 * 1000) / 1000;
}

/** How long the charge takes, minutes: at the lower of the station's and the vehicle's power, slower above 80%. */
export function chargeMinutes(profile: EvProfile, station: SimStation, energyKwh: number, toSoc: number): number {
  const kw = Math.min(station.power_kw, profile.maxChargeKw) * (toSoc > 80 ? 0.8 : 0.95);
  return Math.max(5, Math.round((energyKwh / kw) * 60));
}

/** What the session costs, whole cents (ETB). */
export const chargeCostCents = (station: SimStation, energyKwh: number): number => Math.round(energyKwh * station.tariff_cents_per_kwh);
