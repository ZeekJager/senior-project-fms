import type { ReportKind, ReportRow } from './reports';

// The KPI dashboard (FMS-160, docs/reports.md#kpis): each KPI is read from the totals of the report it opens, for the
// same period and filters, so the two always agree. Targets and the amber band are settings (FMS-157, category KPI
// targets): a KPI on its target's good side is green, within the amber band past it amber, beyond that red. Pure.

export const KPI_KEYS = [
  'cost_per_km',
  'fuel_l_per_100km',
  'utilisation_pct',
  'availability_pct',
  'on_time_pct',
  'pm_compliance_pct',
  'incidents_per_100k_km',
  'vehicles_at_risk',
  'appeals',
  'feedback',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

/** How a value reads: cents per km; tenths of L/100 km; a whole percent; tenths of a rate; a count. */
export type KpiUnit = 'cents_per_km' | 'tenths_l_per_100km' | 'pct' | 'tenths_per_100k_km' | 'count';

export interface KpiDefinition {
  key: KpiKey;
  label: string;
  unit: KpiUnit;
  /** The report it opens, and its value from that report's totals (null: nothing to judge). */
  report: ReportKind | null;
  fromTotals: ((totals: ReportRow | null, rows: readonly ReportRow[]) => number | null) | null;
  /** Lower is better (cost, fuel, incidents, vehicles at risk), or higher (utilisation, availability, on time, PM). */
  better: 'lower' | 'higher' | null;
  /** The setting holding its target; none for the appeal and feedback counts. */
  targetSetting: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The share of completed trips judged on time, from the trip history's rows (its totals hold it as text). */
function onTime(rows: readonly ReportRow[]): number | null {
  const judged = rows.filter((r) => r.on_time === 'Yes' || r.on_time === 'No');
  return judged.length ? Math.round((judged.filter((r) => r.on_time === 'Yes').length * 100) / judged.length) : null;
}

/** A KPI's definition, its key first. */
const kpi = (key: KpiKey, def: Omit<KpiDefinition, 'key'>): KpiDefinition => ({ key, ...def });

export const KPIS: readonly KpiDefinition[] = [
  kpi('cost_per_km', { label: 'Cost per km', unit: 'cents_per_km', report: 'cost', fromTotals: (t) => num(t?.cost_per_km_cents), better: 'lower', targetSetting: 'kpi_cost_per_km_target_cents' }),
  // ml per km is tenths of L/100 km.
  kpi('fuel_l_per_100km', { label: 'Fuel use', unit: 'tenths_l_per_100km', report: 'fuel', fromTotals: (t) => num(t?.consumption_ml_per_km), better: 'lower', targetSetting: 'kpi_fuel_target_l100km_tenths' }),
  kpi('utilisation_pct', { label: 'Utilisation', unit: 'pct', report: 'utilisation', fromTotals: (t) => num(t?.utilisation_pct), better: 'higher', targetSetting: 'kpi_utilisation_target_pct' }),
  kpi('availability_pct', { label: 'Availability', unit: 'pct', report: 'utilisation', fromTotals: (t) => num(t?.availability_pct), better: 'higher', targetSetting: 'kpi_availability_target_pct' }),
  kpi('on_time_pct', { label: 'On time', unit: 'pct', report: 'trips', fromTotals: (_t, rows) => onTime(rows), better: 'higher', targetSetting: 'kpi_on_time_target_pct' }),
  kpi('pm_compliance_pct', { label: 'PM compliance', unit: 'pct', report: 'compliance', fromTotals: (t) => num(t?.pm_compliance_pct), better: 'higher', targetSetting: 'kpi_pm_compliance_target_pct' }),
  kpi('incidents_per_100k_km', { label: 'Incidents per 100,000 km', unit: 'tenths_per_100k_km', report: 'safety', fromTotals: (t) => num(t?.incidents_per_100k_km), better: 'lower', targetSetting: 'kpi_incidents_target_per_100k_km' }),
  kpi('vehicles_at_risk', { label: 'Vehicles at risk', unit: 'count', report: null, fromTotals: null, better: 'lower', targetSetting: 'kpi_vehicles_at_risk_target' }),
  kpi('appeals', { label: 'Score appeals', unit: 'count', report: null, fromTotals: null, better: null, targetSetting: null }),
  kpi('feedback', { label: 'Driver feedback', unit: 'count', report: null, fromTotals: null, better: null, targetSetting: null }),
];

/** The settings the KPIs read: each target and the amber band (migration 082). */
export const KPI_SETTING_KEYS = [
  'kpi_cost_per_km_target_cents',
  'kpi_fuel_target_l100km_tenths',
  'kpi_utilisation_target_pct',
  'kpi_availability_target_pct',
  'kpi_on_time_target_pct',
  'kpi_pm_compliance_target_pct',
  'kpi_incidents_target_per_100k_km',
  'kpi_vehicles_at_risk_target',
  'kpi_amber_band_pct',
] as const;

export type KpiStatus = 'green' | 'amber' | 'red' | 'none';

/**
 * A value against its target: on the good side of it (or on it) green; past it by no more than the amber band (a share
 * of the target) amber; further red. No value, or no target, is none. Targets are in the KPI's own unit, except the
 * incidents target, a whole number per 100,000 km against a value in tenths.
 */
export function kpiStatus(def: KpiDefinition, value: number | null, target: number | null, amberPct: number): KpiStatus {
  if (value === null || target === null || def.better === null) return 'none';
  const t = def.unit === 'tenths_per_100k_km' ? target * 10 : target;
  const band = (Math.abs(t) * amberPct) / 100;
  if (def.better === 'lower') {
    if (value <= t) return 'green';
    return value <= t + band ? 'amber' : 'red';
  }
  if (value >= t) return 'green';
  return value >= t - band ? 'amber' : 'red';
}

/** The change from the period before, in the KPI's unit; null when either is missing. */
export const change = (now: number | null, before: number | null): number | null => (now === null || before === null ? null : now - before);
