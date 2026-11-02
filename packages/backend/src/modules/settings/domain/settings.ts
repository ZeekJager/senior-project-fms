// Settings an administrator tunes without a code change (FMS-80, CFG-3, docs/settings.md). Each is a whole
// number with a default in code and a range; settings.settings holds only the ones changed (NULL: the default
// again). The telemetry rules' thresholds are not here: they have a row per depot in tracking.rule_thresholds.

export const SETTING_KEYS = ['fuel_variance_threshold_pct', 'health_alert_below', 'expiry_warning_days'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingDefinition {
  key: SettingKey;
  /** What the number counts, for the screen: `percent`, `score`, `days`. */
  unit: 'percent' | 'score' | 'days';
  min: number;
  max: number;
  default: number;
}

/**
 * The settings, with their CFG-3 defaults. The fuel variance default is FUEL_VARIANCE_THRESHOLD_PCT's (FMS-41),
 * passed in by index.ts, so a deployment that set it keeps it until an administrator changes it here.
 */
export function settingDefinitions(defaults: { fuelVarianceThresholdPct: number }): Record<SettingKey, SettingDefinition> {
  return {
    // A month's fuel this many percent above or below what its trips needed is an anomaly (FMS-41).
    fuel_variance_threshold_pct: { key: 'fuel_variance_threshold_pct', unit: 'percent', min: 1, max: 100, default: defaults.fuelVarianceThresholdPct },
    // A health score below this raises a maintenance risk alert and is "at risk" (FMS-55, FMS-56). Below 85,
    // where "healthy" starts, so "watch" always has room.
    health_alert_below: { key: 'health_alert_below', unit: 'score', min: 50, max: 84, default: 75 },
    // The first expiry warning for a document or driving licence, this many days ahead (FMS-26). Above the
    // 7-day red warning, which stays.
    expiry_warning_days: { key: 'expiry_warning_days', unit: 'days', min: 8, max: 180, default: 30 },
  };
}

/** Every setting's value: the stored one, else the default. */
export type SettingValues = Record<SettingKey, number>;

/** A setting as GET /settings returns it. */
export interface SettingView {
  key: SettingKey;
  value: number;
  default_value: number;
  is_default: boolean;
  unit: SettingDefinition['unit'];
  min: number;
  max: number;
  /** Who last changed it, and when; null while it was never changed. */
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string | null;
}

/** PATCH /settings: a value per setting to change, null to go back to the default. */
export type SettingChanges = Partial<Record<SettingKey, number | null>>;
