import type { SystemParameter } from './registry';

// Settings an administrator tunes without a code change (FMS-80, CFG-3, docs/settings.md). Each is a whole
// number with a default in code and a range; settings.settings holds only the ones changed (NULL: the default
// again). The telemetry rules' thresholds are not here: they have a row per depot in tracking.rule_thresholds.
// Since FMS-157 they are system parameters of the registry (registry.ts) like any other, and these keep the
// typed reads (settings.value) the modules applying them use.

export const SETTING_KEYS = [
  'fuel_variance_threshold_pct',
  'health_alert_below',
  'expiry_warning_days',
  'driver_score_weight_punctuality',
  'driver_score_weight_safety',
  'driver_score_weight_incidents',
  'driver_score_weight_dvir',
  'appeal_window_days',
  'appeal_review_working_days',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingDefinition {
  key: SettingKey;
  /** What the number counts, for the screen: `percent`, `score`, `days`, `weight` (a share of the driver score). */
  unit: 'percent' | 'score' | 'days' | 'weight';
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
    // How much each component counts in the driver performance score (FMS-146, docs/analytics.md): the score divides
    // by their sum, so they need not add up to 100; 0 leaves a component out. They cannot all be 0.
    driver_score_weight_punctuality: { key: 'driver_score_weight_punctuality', unit: 'weight', min: 0, max: 100, default: 35 },
    driver_score_weight_safety: { key: 'driver_score_weight_safety', unit: 'weight', min: 0, max: 100, default: 35 },
    driver_score_weight_incidents: { key: 'driver_score_weight_incidents', unit: 'weight', min: 0, max: 100, default: 20 },
    driver_score_weight_dvir: { key: 'driver_score_weight_dvir', unit: 'weight', min: 0, max: 100, default: 10 },
    // Score appeals (FMS-159, docs/score-appeals.md): how long after a flag, an incident or the end of a month a driver
    // may appeal it, and how many working days (Monday to Friday) a reviewer has to decide before it is overdue.
    appeal_window_days: { key: 'appeal_window_days', unit: 'days', min: 1, max: 365, default: 30 },
    appeal_review_working_days: { key: 'appeal_review_working_days', unit: 'days', min: 1, max: 30, default: 5 },
  };
}

/** The driver score's weights: at least one must be above 0, or no driver could be scored. */
export const DRIVER_SCORE_WEIGHT_KEYS: readonly SettingKey[] = [
  'driver_score_weight_punctuality',
  'driver_score_weight_safety',
  'driver_score_weight_incidents',
  'driver_score_weight_dvir',
];

const COPY: Record<SettingKey, { label: string; category: string; description: string; unit: string }> = {
  fuel_variance_threshold_pct: {
    label: 'Fuel variance',
    category: 'Alerts and anomalies',
    description: "A vehicle's month of fuel this far above or below what its trips needed is an anomaly.",
    unit: '%',
  },
  health_alert_below: {
    label: 'Health score alert line',
    category: 'Alerts and anomalies',
    description: 'Below this a technician is alerted and the vehicle shows At risk. Healthy starts at 85.',
    unit: 'score',
  },
  expiry_warning_days: {
    label: 'Expiry warning',
    category: 'Alerts and anomalies',
    description: 'The first warning for a document or driving licence; the red one stays at 7 days.',
    unit: 'days',
  },
  driver_score_weight_punctuality: {
    label: 'Punctuality',
    category: 'Driver score',
    description: 'How much trips ended within 15 minutes of their scheduled end count in the driver score.',
    unit: 'weight',
  },
  driver_score_weight_safety: {
    label: 'Safety',
    category: 'Driver score',
    description: 'How much speeding and idling per 100 km count in the driver score.',
    unit: 'weight',
  },
  driver_score_weight_incidents: {
    label: 'Incidents',
    category: 'Driver score',
    description: 'How much accidents per 100 km count in the driver score.',
    unit: 'weight',
  },
  driver_score_weight_dvir: {
    label: 'Inspections',
    category: 'Driver score',
    description: "How much completed trips with the driver's pre-trip inspection count in the driver score.",
    unit: 'weight',
  },
  appeal_window_days: {
    label: 'Appeal window',
    category: 'Score appeals',
    description: 'Days after a flag, an incident or the end of a month in which a driver may appeal it.',
    unit: 'days',
  },
  appeal_review_working_days: {
    label: 'Review deadline',
    category: 'Score appeals',
    description: 'Working days, Monday to Friday, to decide an appeal before it is overdue and goes to the depot admin.',
    unit: 'working days',
  },
};

/** Driver feedback's categories (FMS-158): the options of `feedback_categories`, every one in use by default. */
export const FEEDBACK_CATEGORY_OPTIONS = [
  { value: 'safety', label: 'Safety' },
  { value: 'driving_behaviour', label: 'Driving behaviour' },
  { value: 'fuel_efficiency', label: 'Fuel efficiency' },
  { value: 'punctuality', label: 'Punctuality' },
  { value: 'vehicle_care', label: 'Vehicle care' },
  { value: 'general', label: 'General comment' },
] as const;

/**
 * System parameters that are no whole-number setting, read with `settings.get(key)`: driver feedback's categories in
 * use and how long it is kept (FMS-158, docs/driver-feedback.md).
 */
export const OTHER_PARAMETERS: readonly SystemParameter[] = [
  {
    key: 'feedback_categories',
    label: 'Feedback categories',
    category: 'Driver feedback',
    description: 'The categories a manager files feedback under. At least one.',
    type: 'multi_select',
    default_value: FEEDBACK_CATEGORY_OPTIONS.map((o) => o.value),
    rules: { options: FEEDBACK_CATEGORY_OPTIONS.map((o) => ({ ...o })), min_items: 1 },
    storage: 'settings',
  },
  {
    key: 'feedback_retention_months',
    label: 'Feedback kept',
    category: 'Driver feedback',
    description: 'Months feedback is kept, retracted items too; older items are deleted each night.',
    type: 'integer',
    default_value: 24,
    rules: { min: 1, max: 120, unit: 'months' },
    storage: 'settings',
  },
];

/** The settings as system parameters of the registry (FMS-157): whole numbers in settings.settings, and the others. */
export function settingParameters(definitions: Record<SettingKey, SettingDefinition>): SystemParameter[] {
  return [
    ...SETTING_KEYS.map((key): SystemParameter => {
      const d = definitions[key];
      const { unit, ...copy } = COPY[key];
      return { key, ...copy, type: 'integer', default_value: d.default, rules: { min: d.min, max: d.max, unit }, storage: 'settings' };
    }),
    ...OTHER_PARAMETERS,
  ];
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
