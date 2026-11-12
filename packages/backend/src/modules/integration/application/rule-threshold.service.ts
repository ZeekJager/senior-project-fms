import type { PoolClient } from 'pg';
import type { Scope } from '../../../shared/authz/scope';
import { notFound, validationFailed } from '../../../shared/errors/app-error';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import { DEFAULT_DELAY_MARGINS, DEFAULT_EXCEPTION_POLICIES, type ExceptionPolicy } from '../../trip';
import { DEFAULT_LOCATION_THRESHOLDS } from '../domain/location-rules';
import { DEFAULT_THRESHOLDS, type RuleThresholds } from '../domain/telemetry-rules';
import type { RuleThresholdRepository, ThresholdRow } from '../infrastructure/rule-threshold.repository';

/** Every threshold of a row: speeding and idling (FMS-46), route deviation (FMS-90), and the trip delay margins (FMS-147). */
export interface ThresholdSet extends RuleThresholds {
  routeDeviationM: number;
  routeDeviationPings: number;
  /** Minutes past the scheduled end a trip is expected before it is late, and before it is urgent (above the first). */
  tripDelayMinutes: number;
  tripDelayUrgentMinutes: number;
  /** FMS-151: whether the driver's attendance, and a previous trip running over, only warn or hold an assignment for approval. */
  attendanceException: ExceptionPolicy;
  overrunException: ExceptionPolicy;
}

/** The thresholds a PUT may leave out: each keeps the row's value (or the starting one). */
type LaterThresholds = 'routeDeviationM' | 'routeDeviationPings' | 'tripDelayMinutes' | 'tripDelayUrgentMinutes' | 'attendanceException' | 'overrunException';

/** A PUT's thresholds: route deviation's and the delay margins left out keep the row's. */
export type ThresholdInput = RuleThresholds & Partial<Pick<ThresholdSet, LaterThresholds>>;

export const DEFAULT_THRESHOLD_SET: ThresholdSet = {
  ...DEFAULT_THRESHOLDS,
  routeDeviationM: DEFAULT_LOCATION_THRESHOLDS.routeDeviationM,
  routeDeviationPings: DEFAULT_LOCATION_THRESHOLDS.routeDeviationPings,
  tripDelayMinutes: DEFAULT_DELAY_MARGINS.lateMinutes,
  tripDelayUrgentMinutes: DEFAULT_DELAY_MARGINS.urgentMinutes,
  attendanceException: DEFAULT_EXCEPTION_POLICIES.attendance,
  overrunException: DEFAULT_EXCEPTION_POLICIES.overrun,
};

/** The telemetry rules' thresholds as GET /settings/telemetry-rules returns them. */
export interface ThresholdsView {
  speed_limit_kmh: number;
  speeding_pings: number;
  clear_pings: number;
  idle_minutes: number;
  route_deviation_m: number;
  route_deviation_pings: number;
  trip_delay_minutes: number;
  trip_delay_urgent_minutes: number;
  driver_attendance_exception: ExceptionPolicy;
  trip_overrun_exception: ExceptionPolicy;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string | null;
}

export interface RuleThresholdServiceDeps {
  db: Queryable;
  thresholds: RuleThresholdRepository;
  transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  refs: {
    depots: {
      resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
      publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
    };
    users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]> };
  };
  /** Called after a change, so the rules on this instance use it from the next ping. */
  onChange: () => void;
}

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

const depotNotFound = () => notFound('Depot not found.');

/**
 * The speeding, idling (FMS-46), route deviation (FMS-90) and trip delay (FMS-147) thresholds from the settings screen (FMS-80): the
 * fleet's, and a depot's that replace them for its vehicles. Every change is audited; the rules pick it up within a minute on every instance
 * (THRESHOLDS_TTL_MS), at once on the one that saved it.
 */
export class RuleThresholdService {
  constructor(private readonly deps: RuleThresholdServiceDeps) {}

  /** GET /settings/telemetry-rules. */
  async list(): Promise<{ fleet: ThresholdsView; depots: (ThresholdsView & { depot_id: string })[] }> {
    const { db, thresholds, refs } = this.deps;
    const rows = await thresholds.all(db);
    const depotIds = rows.flatMap((r) => (r.depotId ? [r.depotId] : []));
    const userIds = [...new Set(rows.flatMap((r) => (r.updatedBy ? [r.updatedBy] : [])))];
    // One after another: they may share one connection.
    const depots = await refs.depots.publicIds(db, depotIds);
    const users = await refs.users.findByIds(db, userIds);
    const byUser = new Map(users.map((u) => [u.id, u]));
    const view = (r: ThresholdRow | undefined): ThresholdsView => {
      const t = r ?? DEFAULT_THRESHOLD_SET;
      const editor = r?.updatedBy ? byUser.get(r.updatedBy) : undefined;
      return {
        speed_limit_kmh: t.speedLimitKmh,
        speeding_pings: t.speedingPings,
        clear_pings: t.clearPings,
        idle_minutes: t.idleMinutes,
        route_deviation_m: t.routeDeviationM,
        route_deviation_pings: t.routeDeviationPings,
        trip_delay_minutes: t.tripDelayMinutes,
        trip_delay_urgent_minutes: t.tripDelayUrgentMinutes,
        driver_attendance_exception: t.attendanceException,
        trip_overrun_exception: t.overrunException,
        updated_by: editor?.publicId ?? null,
        updated_by_name: editor?.fullName ?? null,
        updated_at: r?.updatedBy ? r.updatedAt.toISOString() : null,
      };
    };
    return {
      fleet: view(rows.find((r) => r.depotId === null)),
      depots: rows.flatMap((r) => (r.depotId && depots.has(r.depotId) ? [{ depot_id: depots.get(r.depotId)!, ...view(r) }] : [])),
    };
  }

  /** PUT /settings/telemetry-rules/fleet, or a depot's (its public id): creates or replaces the row. */
  async set(caller: Caller, depotPublicId: string | null, input: ThresholdInput): Promise<void> {
    const ctx = { userId: caller.user.id, correlationId: caller.correlationId };
    await this.deps.transaction(async (client) => {
      const depotId = depotPublicId === null ? null : await this.deps.refs.depots.resolveInScope(client, depotPublicId, { kind: 'all' });
      if (depotPublicId !== null && depotId === null) throw depotNotFound();
      const current = await this.deps.thresholds.lock(client, depotId);
      const kept = <K extends LaterThresholds>(key: K): ThresholdSet[K] => (input[key] as ThresholdSet[K] | undefined) ?? current?.[key] ?? DEFAULT_THRESHOLD_SET[key];
      const t: ThresholdSet = {
        ...input,
        routeDeviationM: kept('routeDeviationM'),
        routeDeviationPings: kept('routeDeviationPings'),
        tripDelayMinutes: kept('tripDelayMinutes'),
        tripDelayUrgentMinutes: kept('tripDelayUrgentMinutes'),
        attendanceException: kept('attendanceException'),
        overrunException: kept('overrunException'),
      };
      // Urgent is later than late (chk_rule_trip_delay_urgent).
      if (t.tripDelayUrgentMinutes <= t.tripDelayMinutes) {
        throw validationFailed(
          [{ field: 'trip_delay_urgent_minutes', reason: 'not_above_late' }],
          `A trip is urgent later than it is late: more than ${t.tripDelayMinutes} minutes.`,
        );
      }
      if (!current) await this.deps.thresholds.insert(client, ctx, depotId, t);
      else if (!same(current, t)) await this.deps.thresholds.update(client, ctx, current.id, t);
    });
    this.deps.onChange();
  }

  /** DELETE /settings/telemetry-rules/depots/{depot_id}: the depot follows the fleet's thresholds again. 404 when it had none of its own. */
  async remove(caller: Caller, depotPublicId: string): Promise<void> {
    const ctx = { userId: caller.user.id, correlationId: caller.correlationId };
    await this.deps.transaction(async (client) => {
      const depotId = await this.deps.refs.depots.resolveInScope(client, depotPublicId, { kind: 'all' });
      if (depotId === null) throw depotNotFound();
      const current = await this.deps.thresholds.lock(client, depotId);
      if (!current) throw notFound('This depot has no thresholds of its own.');
      await this.deps.thresholds.remove(client, ctx, current);
    });
    this.deps.onChange();
  }
}

function same(a: ThresholdSet, b: ThresholdSet): boolean {
  return (
    a.speedLimitKmh === b.speedLimitKmh &&
    a.speedingPings === b.speedingPings &&
    a.clearPings === b.clearPings &&
    a.idleMinutes === b.idleMinutes &&
    a.routeDeviationM === b.routeDeviationM &&
    a.routeDeviationPings === b.routeDeviationPings &&
    a.tripDelayMinutes === b.tripDelayMinutes &&
    a.tripDelayUrgentMinutes === b.tripDelayUrgentMinutes &&
    a.attendanceException === b.attendanceException &&
    a.overrunException === b.overrunException
  );
}
