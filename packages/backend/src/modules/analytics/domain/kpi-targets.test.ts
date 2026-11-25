import { describe, expect, test } from 'vitest';
import { KPIS, KPI_SETTING_KEYS, change, kpiStatus, type KpiKey } from './kpi-targets';

// FMS-160: a KPI's status against its target and amber band (settings, FMS-157).

const def = (key: KpiKey) => KPIS.find((k) => k.key === key)!;

describe('kpiStatus', () => {
  test('lower is better: on or under the target green, within the band over it amber, beyond red', () => {
    const cost = def('cost_per_km');
    expect(kpiStatus(cost, 3500, 3500, 10)).toBe('green');
    expect(kpiStatus(cost, 3850, 3500, 10)).toBe('amber');
    expect(kpiStatus(cost, 3851, 3500, 10)).toBe('red');
  });

  test('higher is better: the mirror image', () => {
    const util = def('utilisation_pct');
    expect(kpiStatus(util, 80, 75, 10)).toBe('green');
    expect(kpiStatus(util, 68, 75, 10)).toBe('amber');
    expect(kpiStatus(util, 67, 75, 10)).toBe('red');
  });

  test('a changed target or band changes the status', () => {
    const util = def('utilisation_pct');
    expect(kpiStatus(util, 70, 75, 10)).toBe('amber');
    expect(kpiStatus(util, 70, 70, 10)).toBe('green');
    expect(kpiStatus(util, 70, 75, 0)).toBe('red');
  });

  test('the incidents target is whole incidents per 100,000 km, the value tenths', () => {
    const incidents = def('incidents_per_100k_km');
    expect(kpiStatus(incidents, 50, 5, 10)).toBe('green');
    expect(kpiStatus(incidents, 55, 5, 10)).toBe('amber');
    expect(kpiStatus(incidents, 56, 5, 10)).toBe('red');
  });

  test('no value, no target, or nothing to judge (appeals, feedback) is none', () => {
    expect(kpiStatus(def('cost_per_km'), null, 3500, 10)).toBe('none');
    expect(kpiStatus(def('cost_per_km'), 100, null, 10)).toBe('none');
    expect(kpiStatus(def('appeals'), 3, 1, 10)).toBe('none');
  });
});

test('every target is a setting; change is the difference, null when either side is missing', () => {
  for (const k of KPIS) if (k.targetSetting) expect(KPI_SETTING_KEYS).toContain(k.targetSetting);
  expect(KPI_SETTING_KEYS).toContain('kpi_amber_band_pct');
  expect(change(80, 75)).toBe(5);
  expect(change(80, null)).toBeNull();
});
