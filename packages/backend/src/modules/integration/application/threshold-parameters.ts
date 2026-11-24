import type { PoolClient } from 'pg';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { ParameterStore, StoredValue, SystemParameter, ValueChange } from '../../settings';
import type { RuleThresholdRepository } from '../infrastructure/rule-threshold.repository';
import { DEFAULT_THRESHOLD_SET, type RuleThresholdService, type ThresholdSet } from './rule-threshold.service';

// The driving rules' thresholds as system parameters of the settings registry (FMS-157, docs/settings.md). Their
// values stay in the fleet's row of tracking.rule_thresholds, where each depot's own row still overrides them, so
// nothing about how they apply changes; the registry shows them, changes them (with a reason) and keeps their history.

interface ThresholdParameter extends Omit<SystemParameter, 'default_value' | 'storage'> {
  field: keyof ThresholdSet;
  /** The column of tracking.rule_thresholds, for the history from the audit trail. */
  column: string;
}

const POLICY_OPTIONS = [
  { value: 'warn', label: 'Warn, then assign' },
  { value: 'approve', label: 'Needs a fleet manager’s approval' },
];

const whole = (min: number, max: number, unit: string) => ({ type: 'integer' as const, rules: { min, max, unit } });
const weight = { type: 'number' as const, rules: { min: 0.5, max: 3, decimals: 2, unit: '×' } };

/** Each threshold, with the ranges tracking.rule_thresholds checks (migrations 035, 060, 068, 070, 074). */
const PARAMETERS: ThresholdParameter[] = [
  { key: 'speed_limit_kmh', field: 'speedLimitKmh', column: 'speed_limit_kmh', label: 'Speed limit', category: 'Driving rules', description: 'Exactly the limit is not speeding. A depot can have its own.', ...whole(20, 200, 'km/h') },
  { key: 'speeding_pings', field: 'speedingPings', column: 'speeding_pings', label: 'Speeding after', category: 'Driving rules', description: 'Pings in a row over the limit. A ping comes about every 10 s.', ...whole(1, 20, 'pings') },
  { key: 'clear_pings', field: 'clearPings', column: 'clear_pings', label: 'Cleared after', category: 'Driving rules', description: 'Pings in a row at or under the limit, or back on the route.', ...whole(1, 20, 'pings') },
  { key: 'idle_minutes', field: 'idleMinutes', column: 'idle_minutes', label: 'Idling after', category: 'Driving rules', description: 'Minutes at 0 km/h with the engine not reported off.', ...whole(1, 120, 'min') },
  { key: 'route_deviation_m', field: 'routeDeviationM', column: 'route_deviation_m', label: 'Off route beyond', category: 'Driving rules', description: 'Metres from the trip’s road. GPS drifts 10 to 50 m.', ...whole(100, 5000, 'm') },
  { key: 'route_deviation_pings', field: 'routeDeviationPings', column: 'route_deviation_pings', label: 'Off route after', category: 'Driving rules', description: 'Pings in a row that far out.', ...whole(1, 20, 'pings') },
  { key: 'trip_delay_minutes', field: 'tripDelayMinutes', column: 'trip_delay_minutes', label: 'Trip late after', category: 'Trip delays', description: 'Minutes a trip is expected past its scheduled end before dispatchers are told.', ...whole(5, 240, 'min') },
  { key: 'trip_delay_urgent_minutes', field: 'tripDelayUrgentMinutes', column: 'trip_delay_urgent_minutes', label: 'Trip urgent after', category: 'Trip delays', description: 'Minutes past its end before they are told again by email, SMS and push. Later than late.', ...whole(10, 720, 'min') },
  { key: 'driver_attendance_exception', field: 'attendanceException', column: 'attendance_exception', label: 'Driver marked absent', category: 'Assignment', description: 'Assigning a driver who is absent, on leave or sick on the trip’s day.', type: 'dropdown', rules: { options: POLICY_OPTIONS } },
  { key: 'trip_overrun_exception', field: 'overrunException', column: 'overrun_exception', label: 'Previous trip running over', category: 'Assignment', description: 'Assigning a driver or vehicle whose trip still under way runs into this one.', type: 'dropdown', rules: { options: POLICY_OPTIONS } },
  { key: 'daily_distance_km', field: 'dailyDistanceKm', column: 'daily_distance_km', label: 'Daily limit', category: 'Distance limits', description: 'Load-weighted km a driver may be given in a calendar day in Addis Ababa.', ...whole(50, 2000, 'km') },
  { key: 'weekly_distance_km', field: 'weeklyDistanceKm', column: 'weekly_distance_km', label: 'Weekly limit', category: 'Distance limits', description: 'Load-weighted km a driver may be given Monday to Sunday. At least the daily limit.', ...whole(100, 10000, 'km') },
  { key: 'distance_weight_light', field: 'distanceWeightLight', column: 'distance_weight_light', label: 'Light job', category: 'Distance limits', description: 'What a km of a light job counts for: short, few stops, little cargo.', ...weight },
  { key: 'distance_weight_standard', field: 'distanceWeightStandard', column: 'distance_weight_standard', label: 'Standard job', category: 'Distance limits', description: 'What a km of a standard job counts for.', ...weight },
  { key: 'distance_weight_heavy', field: 'distanceWeightHeavy', column: 'distance_weight_heavy', label: 'Heavy job', category: 'Distance limits', description: 'What a km of a heavy job counts for: long haul, long hours, night, near payload. Never less than standard.', ...weight },
];

const BY_KEY = new Map(PARAMETERS.map((p) => [p.key, p]));
const BY_FIELD = new Map(PARAMETERS.map((p) => [p.field, p]));

/** The registry keys of these fields of a ThresholdSet. */
export function thresholdKeysOf(fields: readonly (keyof ThresholdSet)[]): string[] {
  return fields.flatMap((f) => (BY_FIELD.get(f) ? [BY_FIELD.get(f)!.key] : []));
}

/** A column's value as the audit trail kept it, as the parameter's type: numeric columns are copied as text ("0.80"). */
function typed(p: ThresholdParameter, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  return p.type === 'dropdown' ? String(v) : Number(v);
}

export interface ThresholdStoreDeps {
  thresholds: RuleThresholdRepository;
  service: RuleThresholdService;
  /** The audited changes of records of a table, newest first (the audit module's trail). */
  trail: (db: Queryable, entityType: string, ids: readonly string[]) => Promise<{ id: string; at: Date; userId: string | null; action: string; oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> | null }[]>;
}

/** The store the settings registry reads and writes the thresholds through. */
export function thresholdParameterStore(deps: ThresholdStoreDeps): ParameterStore {
  return {
    storage: 'rule_thresholds',
    parameters: PARAMETERS.map(({ field, column, ...p }) => {
      void column;
      return { ...p, default_value: DEFAULT_THRESHOLD_SET[field], storage: 'rule_thresholds' };
    }),

    async read(db: Queryable): Promise<Map<string, StoredValue>> {
      const fleet = (await deps.thresholds.all(db)).find((r) => r.depotId === null);
      return new Map(
        PARAMETERS.map((p) => [
          p.key,
          { value: fleet ? fleet[p.field] : DEFAULT_THRESHOLD_SET[p.field], updatedBy: fleet?.updatedBy ?? null, updatedAt: fleet?.updatedBy ? fleet.updatedAt : null },
        ]),
      );
    },

    async write(client: PoolClient, ctx: MutationContext, values: ReadonlyMap<string, unknown>, reason: string | null): Promise<string[]> {
      const changes: Partial<Record<keyof ThresholdSet, unknown>> = {};
      for (const [key, v] of values) {
        const p = BY_KEY.get(key);
        if (p) changes[p.field] = v;
      }
      const fields = await deps.service.applyFleet(client, ctx, changes as Partial<ThresholdSet>, reason);
      return thresholdKeysOf(fields);
    },

    async history(db: Queryable, key: string): Promise<ValueChange[]> {
      const p = BY_KEY.get(key);
      if (!p) return [];
      const fleet = (await deps.thresholds.all(db)).find((r) => r.depotId === null);
      if (!fleet) return [];
      const rows = await deps.trail(db, 'tracking.rule_thresholds', [fleet.id]);
      return rows.flatMap((r) => {
        const before = r.action === 'INSERT' ? typed(p, DEFAULT_THRESHOLD_SET[p.field]) : typed(p, r.oldValues?.[p.column]);
        const after = typed(p, r.newValues?.[p.column]);
        if (before === after) return [];
        return [{ id: r.id, at: r.at, userId: r.userId, oldValue: before, newValue: after, reason: (r.newValues?.change_reason as string | null | undefined) ?? null }];
      });
    },
  };
}
