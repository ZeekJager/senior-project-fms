import { depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import type { Cache } from '../../../shared/cache/cache';
import type { DataFreshness, ReadSession } from '../../../shared/infrastructure/read-router';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { JobContext } from '../../../shared/jobs/job';
import type { RequestUser } from '../../../types/express';
import {
  ALERT_SEVERITIES,
  BACKFILL_DAYS,
  NIGHTLY_DAYS,
  RESPONSE_TTL_SECONDS,
  TRIP_STATUSES,
  VEHICLE_STATUSES,
  addisDay,
  costPerKm,
  dayStart,
  isStale,
  km,
  mlPerKm,
  pct,
  rangeOf,
  roundDiv,
  shiftDay,
  type DayFigures,
  type Range,
} from '../domain/kpis';
import type { AnalyticsRepository, Audience, CacheRow, Totals } from '../infrastructure/analytics.repository';

export interface AnalyticsQuery {
  from?: string;
  to?: string;
  depot_id?: string;
}

export interface AnalyticsServiceDeps {
  /** The primary: the refresh writes the cache here. */
  db: Queryable;
  /** Reports, and the refresh's aggregation, read the replica when it is up (FMS-94). */
  reads: { session(): Promise<ReadSession> };
  repo: AnalyticsRepository;
  cache: Cache;
  now?: () => Date;
}

/** What every analytics answer carries in `meta`. */
export interface AnalyticsMeta {
  from: string;
  to: string;
  days: number;
  /** The cache's last refresh; the KPIs are as of then. */
  computed_at: string | null;
  /** True when the cache was not refreshed for 25 hours (or never). */
  stale: boolean;
  data_freshness: DataFreshness;
}

export type Report = 'fleet-summary' | 'utilisation' | 'fuel-efficiency' | 'maintenance-risk' | 'trips' | 'alerts';

/** How many cache rows one upsert writes. */
const UPSERT_BATCH = 5_000;

const counts = (keys: readonly string[], found: Record<string, number>) => Object.fromEntries(keys.map((k) => [k, found[k] ?? 0]));
const sum = (values: Iterable<number>) => [...values].reduce((a, b) => a + b, 0);

/** Fleet KPIs from the cache, shared by the summary, the trips report and each day of the series. */
function kpis(t: Totals) {
  const totalCost = t.fuelCostCents + t.maintenanceCostCents;
  return {
    utilisation_pct: pct(t.usedDays, t.vehicleDays),
    distance_km: km(t.distanceM),
    trips_completed: t.tripsCompleted,
    on_time_pct: pct(t.tripsOnTime, t.tripsTimed),
    fuel_ml: t.fuelMl,
    fuel_cost_cents: t.fuelCostCents,
    maintenance_cost_cents: t.maintenanceCostCents,
    total_cost_cents: totalCost,
    cost_per_km_cents: costPerKm(totalCost, t.distanceM),
  };
}

const EMPTY: Totals = { usedDays: 0, vehicleDays: 0, distanceM: 0, tripsCompleted: 0, tripsTimed: 0, tripsOnTime: 0, fuelMl: 0, fuelCostCents: 0, maintenanceCostCents: 0 };

function add(a: Totals, b: Totals): Totals {
  return {
    usedDays: a.usedDays + b.usedDays,
    vehicleDays: a.vehicleDays + b.vehicleDays,
    distanceM: a.distanceM + b.distanceM,
    tripsCompleted: a.tripsCompleted + b.tripsCompleted,
    tripsTimed: a.tripsTimed + b.tripsTimed,
    tripsOnTime: a.tripsOnTime + b.tripsOnTime,
    fuelMl: a.fuelMl + b.fuelMl,
    fuelCostCents: a.fuelCostCents + b.fuelCostCents,
    maintenanceCostCents: a.maintenanceCostCents + b.maintenanceCostCents,
  };
}

/** The cache row of a computed day: the ratios, integers, beside the raw figures. */
export function cacheRow(d: DayFigures): CacheRow {
  return {
    ...d,
    utilisationPct: d.used ? 100 : 0,
    costPerKmCents: costPerKm(d.fuelCostCents + d.maintenanceCostCents, d.distanceM) ?? 0,
    onTimePct: pct(d.tripsOnTime, d.tripsTimed),
  };
}

/**
 * Fleet analytics (FMS-50, api-contract §14): KPIs pre-aggregated per vehicle and day into analytics_cache by an
 * hourly and a nightly refresh, read from the replica, summed for any range of days, and kept in Redis for 5 minutes
 * per audience and range. Integers throughout: percentages, ml, cents, cents per km. Staff see their depots (admins,
 * fleet managers and owners all of them); a driver sees nothing.
 */
export class AnalyticsService {
  private readonly now: () => Date;

  constructor(private readonly deps: AnalyticsServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async report(report: Report, user: RequestUser | undefined, query: AnalyticsQuery): Promise<{ data: unknown; meta: AnalyticsMeta }> {
    const range = rangeOf(query, this.now());
    const scope = staffScope(user);
    const { cache } = this.deps;
    const key = cache.key('analytics', report, scopeKey(scope), query.depot_id ?? 'all', range.from, range.to);
    return cache.getOrSet(key, RESPONSE_TTL_SECONDS, async () => {
      const db = await this.deps.reads.session();
      const a: Audience = { scope };
      if (query.depot_id) {
        const depotId = await this.deps.repo.depotInScope(db, query.depot_id, scope);
        // A depot that is unknown, or not one of the caller's, matches nothing: zeros, as a filter does elsewhere.
        if (depotId) a.depotId = depotId;
        else a.scope = { kind: 'none' };
      }
      const computedAt = await this.deps.repo.lastComputedAt(db);
      const data = await this.build(report, db, a, range);
      return {
        data,
        meta: {
          from: range.from,
          to: range.to,
          days: range.days,
          computed_at: computedAt ? computedAt.toISOString() : null,
          stale: isStale(computedAt, this.now()),
          data_freshness: db.freshness(),
        },
      };
    });
  }

  private build(report: Report, db: Queryable, a: Audience, range: Range): Promise<unknown> {
    switch (report) {
      case 'fleet-summary':
        return this.fleetSummary(db, a, range);
      case 'utilisation':
        return this.utilisation(db, a, range);
      case 'fuel-efficiency':
        return this.fuelEfficiency(db, a, range);
      case 'maintenance-risk':
        return this.maintenanceRisk(db, a, range);
      case 'trips':
        return this.trips(db, a, range);
      case 'alerts':
        return this.alerts(db, a, range);
    }
  }

  private async fleetSummary(db: Queryable, a: Audience, range: Range) {
    const { repo } = this.deps;
    const vehicles = await repo.vehicles(db, a);
    const daily = await repo.totalsByDay(db, vehicles.map((v) => v.vehicleId), range.from, range.to);
    const open = await repo.openAlerts(db, a);
    const total = daily.reduce((t, d) => add(t, d.totals), EMPTY);
    const byStatus: Record<string, number> = {};
    for (const v of vehicles) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
    const scored = vehicles.filter((v) => v.healthScore !== null && v.status !== 'retired');
    const openAlerts = counts(ALERT_SEVERITIES, open);
    return {
      vehicles: {
        total: vehicles.length,
        by_status: counts(VEHICLE_STATUSES, byStatus),
        maintenance_flagged: vehicles.filter((v) => v.maintenanceFlag && v.status !== 'retired').length,
        average_health_score: scored.length ? Math.round(sum(scored.map((v) => v.healthScore!)) / scored.length) : null,
      },
      ...kpis(total),
      open_alerts: { ...openAlerts, total: sum(Object.values(openAlerts)) },
      daily: daily.map((d) => ({ date: d.day, vehicles_used: d.totals.usedDays, ...kpis(d.totals) })),
    };
  }

  private async utilisation(db: Queryable, a: Audience, range: Range) {
    const { repo } = this.deps;
    const vehicles = await repo.vehicles(db, a);
    const totals = await repo.totalsByVehicle(db, a, range.from, range.to);
    const rows = vehicles
      .filter((v) => totals.has(v.vehicleId))
      .map((v) => {
        const t = totals.get(v.vehicleId)!;
        return {
          vehicle_id: v.publicId,
          registration_number: v.registrationNumber,
          depot_id: v.depotPublicId,
          depot_name: v.depotName,
          status: v.status,
          days_used: t.usedDays,
          days: t.vehicleDays,
          utilisation_pct: pct(t.usedDays, t.vehicleDays),
          distance_km: km(t.distanceM),
          trips_completed: t.tripsCompleted,
        };
      })
      .sort((x, y) => (y.utilisation_pct ?? -1) - (x.utilisation_pct ?? -1) || x.registration_number.localeCompare(y.registration_number));
    const total = [...totals.values()].reduce(add, EMPTY);
    return { utilisation_pct: pct(total.usedDays, total.vehicleDays), vehicle_days: total.vehicleDays, days_used: total.usedDays, vehicles: rows };
  }

  private async fuelEfficiency(db: Queryable, a: Audience, range: Range) {
    const { repo } = this.deps;
    const vehicles = await repo.vehicles(db, a);
    const totals = await repo.totalsByVehicle(db, a, range.from, range.to);
    return vehicles
      .filter((v) => totals.has(v.vehicleId))
      .map((v) => {
        const t = totals.get(v.vehicleId)!;
        const actual = mlPerKm(t.fuelMl, t.distanceM);
        return {
          vehicle_id: v.publicId,
          registration_number: v.registrationNumber,
          depot_id: v.depotPublicId,
          depot_name: v.depotName,
          fuel_type: v.fuelType,
          fuel_ml: t.fuelMl,
          fuel_cost_cents: t.fuelCostCents,
          distance_km: km(t.distanceM),
          ml_per_km: actual,
          rated_ml_per_km: v.ratedMlPerKm,
          variance_pct: actual !== null && v.ratedMlPerKm ? pct(actual - v.ratedMlPerKm, v.ratedMlPerKm) : null,
          fuel_cost_per_km_cents: costPerKm(t.fuelCostCents, t.distanceM),
        };
      })
      .sort((x, y) => y.fuel_cost_cents - x.fuel_cost_cents || x.registration_number.localeCompare(y.registration_number));
  }

  private async maintenanceRisk(db: Queryable, a: Audience, range: Range) {
    const { repo } = this.deps;
    const vehicles = await repo.vehicles(db, a);
    const risks = await repo.risks(db, a);
    const totals = await repo.totalsByVehicle(db, a, range.from, range.to);
    return vehicles
      .filter((v) => v.status !== 'retired')
      .map((v) => {
        const risk = risks.get(v.vehicleId);
        return {
          vehicle_id: v.publicId,
          registration_number: v.registrationNumber,
          depot_id: v.depotPublicId,
          depot_name: v.depotName,
          status: v.status,
          health_score: v.healthScore,
          maintenance_flag: v.maintenanceFlag,
          risk_pct: risk?.riskScore ?? null,
          prediction_type: risk?.predictionType ?? null,
          predicted_failure_type: risk?.failureType ?? null,
          predicted_at: risk ? risk.generatedAt.toISOString() : null,
          maintenance_cost_cents: totals.get(v.vehicleId)?.maintenanceCostCents ?? 0,
        };
      })
      .sort((x, y) => (y.risk_pct ?? -1) - (x.risk_pct ?? -1) || (x.health_score ?? 101) - (y.health_score ?? 101) || x.registration_number.localeCompare(y.registration_number));
  }

  private async trips(db: Queryable, a: Audience, range: Range) {
    const { repo } = this.deps;
    const end = dayStart(shiftDay(range.to, 1));
    const statuses = await repo.tripsByStatus(db, a, dayStart(range.from), end);
    const vehicles = await repo.vehicles(db, a);
    const daily = await repo.totalsByDay(db, vehicles.map((v) => v.vehicleId), range.from, range.to);
    const total = daily.reduce((t, d) => add(t, d.totals), EMPTY);
    const byStatus = counts(TRIP_STATUSES, statuses);
    return {
      planned: sum(Object.values(byStatus)),
      by_status: byStatus,
      completed: total.tripsCompleted,
      on_time: total.tripsOnTime,
      timed: total.tripsTimed,
      on_time_pct: pct(total.tripsOnTime, total.tripsTimed),
      distance_km: km(total.distanceM),
      average_distance_km: total.tripsCompleted ? km(roundDiv(total.distanceM, total.tripsCompleted)) : null,
      daily: daily.map((d) => ({ date: d.day, completed: d.totals.tripsCompleted, on_time_pct: pct(d.totals.tripsOnTime, d.totals.tripsTimed), distance_km: km(d.totals.distanceM) })),
    };
  }

  private async alerts(db: Queryable, a: Audience, range: Range) {
    const { repo } = this.deps;
    const end = dayStart(shiftDay(range.to, 1));
    const open = await repo.openAlerts(db, a);
    const raised = await repo.alertsRaised(db, a, dayStart(range.from), end);
    const openBySeverity = counts(ALERT_SEVERITIES, open);
    const raisedBySeverity = counts(ALERT_SEVERITIES, Object.fromEntries(raised.bySeverity.map((r) => [r.key, r.count])));
    const perDay = new Map(raised.byDay.map((r) => [r.key, r.count]));
    const daily = [];
    for (let day = range.from; day <= range.to; day = shiftDay(day, 1)) daily.push({ date: day, raised: perDay.get(day) ?? 0 });
    return {
      open: { ...openBySeverity, total: sum(Object.values(openBySeverity)) },
      raised: { ...raisedBySeverity, total: sum(Object.values(raisedBySeverity)) },
      by_type: raised.byType.map((r) => ({ alert_type: r.key, count: r.count })),
      acknowledged: raised.acknowledged,
      mean_minutes_to_acknowledge: raised.meanMinutesToAcknowledge,
      daily,
    };
  }

  /**
   * Recomputes the cache for the Addis Ababa days [from, to] (aggregated on the replica, written to the primary),
   * then drops the cached answers. An empty cache is filled 400 days back first.
   */
  async refresh(context: JobContext, from: string, to: string) {
    const started = Date.now();
    const { repo, db, cache } = this.deps;
    const reads = await this.deps.reads.session();
    const backfill = (await repo.lastComputedAt(db)) === null;
    if (backfill) from = shiftDay(to, 1 - BACKFILL_DAYS);
    const days = await repo.computeDays(reads, from, to);
    for (let i = 0; i < days.length; i += UPSERT_BATCH) await repo.upsert(db, days.slice(i, i + UPSERT_BATCH).map(cacheRow), context.now);
    const dropped = await cache.invalidate('analytics:*');
    return { from, to, backfill, rows: days.length, vehicles: new Set(days.map((d) => d.vehicleId)).size, cached_answers_dropped: dropped, source: reads.freshness().source, duration_ms: Date.now() - started };
  }

  /** Hourly: today and yesterday, so the dashboard is at most an hour behind. */
  hourly(context: JobContext) {
    const today = addisDay(context.now);
    return this.refresh(context, shiftDay(today, -1), today);
  }

  /** Nightly: the last 35 days, for fill-ups, trips and repair costs entered late. */
  nightly(context: JobContext) {
    const today = addisDay(context.now);
    return this.refresh(context, shiftDay(today, 1 - NIGHTLY_DAYS), today);
  }
}

/** Staff see their depots; a caller placed nowhere (or a driver only) sees nothing. */
function staffScope(user: RequestUser | undefined): Scope {
  return ownDriverScope(user).kind === 'all' ? depotScope(user) : { kind: 'none' };
}

const scopeKey = (scope: Scope) => (scope.kind === 'depot' ? `depot-${scope.depotId}` : scope.kind);
