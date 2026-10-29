import { depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent, deterministicEventId, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DataFreshness, ReadSession } from '../../../shared/infrastructure/read-router';
import type { JobContext } from '../../../shared/jobs/job';
import { FUEL_EVENTS, type FuelType } from '../domain/fuel-log';
import {
  MAX_PERIOD_DAYS,
  RECONCILIATION_ANOMALY,
  addisDay,
  judge,
  kmOf,
  periodReversed,
  periodTooLong,
  previousMonth,
  roundDiv,
  severityOf,
  vehicleNotFound,
  type Judgement,
  type NotJudgedReason,
  type ReconciliationStatus,
  type VehicleUsage,
} from '../domain/reconciliation';
import type { FuelAnomalyRepository } from '../infrastructure/fuel-anomaly.repository';
import type { FuelLogRepository } from '../infrastructure/fuel-log.repository';
import type { Caller } from './fuel-log.service';

const DAY_MS = 86_400_000;
/** The fuel summary's default period: the 30 days to now. */
const SUMMARY_DAYS = 30;

/** A vehicle as the reconciliation judges it (fleet's FuelVehicle). Internal ids. */
interface ReconciledVehicle {
  id: string;
  publicId: string;
  depotPublicId: string;
  fuelType: FuelType;
  fuelEfficiencyMlPerKm: number | null;
  isActive: boolean;
}

/**
 * What the reconciliation needs from fleet and trip: a scope's vehicles with their rated efficiency, a depot
 * filter, and the completed trips' distance. Connected in src/modules/fuel/index.ts.
 */
export interface ReconciliationRefs {
  vehicles: { forReconciliation(db: Queryable, scope: Scope, filter?: { publicId?: string; depotId?: string }): Promise<ReconciledVehicle[]> };
  depots: { inScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null> };
  trips: { completedMetres(db: Queryable, vehicleIds: readonly string[], from: Date, to: Date): Promise<Map<string, { distanceM: number; trips: number }>> };
}

export interface ReconciliationServiceDeps {
  /**
   * Where the reads go (FMS-94, §18, Scenario D): one session per request or run, on the read replica when it is up
   * and close enough, the primary otherwise (`db.reads`). Writes (the anomalies) always go to the primary, through
   * `anomalies`.
   */
  reads: { session(): Promise<ReadSession> };
  logs: Pick<FuelLogRepository, 'usageBetween'>;
  anomalies: Pick<FuelAnomalyRepository, 'inTransaction' | 'forPeriod' | 'openCount' | 'insertReconciliation'>;
  refs: ReconciliationRefs;
  events: EventBus;
  /** config.fuel: read on every call, so a change takes effect without a restart in tests. */
  settings: { varianceThresholdPct: number };
}

export interface ReconciliationQuery {
  vehicle_id?: string;
  depot_id?: string;
  from?: Date;
  to?: Date;
  status?: ReconciliationStatus;
  page: number;
  page_size: number;
}

/** One vehicle's period (GET /fuel-reconciliation, api-contract §9.2). Integers; km to 3 decimals. */
export interface ReconciliationView {
  vehicle_id: string;
  depot_id: string;
  fuel_type: FuelType;
  fuel_efficiency_ml_per_km: number | null;
  distance_km: number;
  trips: number;
  fuel_logs: number;
  expected_ml: number | null;
  actual_ml: number;
  variance_ml: number | null;
  variance_pct: number | null;
  total_cost_cents: number;
  status: ReconciliationStatus;
  reason: NotJudgedReason | null;
  /** The anomaly the monthly run raised for exactly this period, if any. */
  anomaly_id: string | null;
}

export interface ReconciliationSummary {
  vehicles: number;
  judged: number;
  above: number;
  below: number;
  /** Over the judged vehicles only: what their distance needed and what they were logged. */
  expected_ml: number;
  actual_ml: number;
  variance_pct: number | null;
  /** Every vehicle's fuel cost, judged or not. */
  total_cost_cents: number;
}

/** GET /vehicles/{id}/fuel-summary (api-contract §9.1). */
export interface FuelSummaryView {
  vehicle_id: string;
  from: Date;
  to: Date;
  fuel_logs: number;
  actual_ml: number;
  total_cost_cents: number;
  trips: number;
  distance_km: number;
  rated_efficiency_ml_per_km: number | null;
  /** ml per km driven; null without distance. */
  actual_efficiency_ml_per_km: number | null;
  expected_ml: number | null;
  variance_ml: number | null;
  variance_pct: number | null;
  status: ReconciliationStatus;
  reason: NotJudgedReason | null;
  cost_per_km_cents: number | null;
  average_price_cents_per_litre: number | null;
  open_anomalies: number;
  threshold_pct: number;
}

interface Line {
  vehicle: ReconciledVehicle;
  usage: VehicleUsage;
  judgement: Judgement;
}

/**
 * Fuel reconciliation (FMS-41, §9.3, Scenario A): each vehicle's fuel logged in a period against what its
 * completed trips needed at its rated efficiency (`fuel_efficiency_ml_per_km`). The monthly run writes a
 * fuel anomaly and publishes FuelAnomalyDetected for a vehicle beyond the threshold; the API reconciles any
 * period on demand and writes nothing.
 */
export class ReconciliationService {
  constructor(private readonly deps: ReconciliationServiceDeps) {}

  async reconcile(
    caller: Caller,
    query: ReconciliationQuery,
  ): Promise<{ items: ReconciliationView[]; total: number; summary: ReconciliationSummary; from: Date; to: Date; thresholdPct: number; freshness: DataFreshness }> {
    const { refs, anomalies } = this.deps;
    const { from, to } = periodOf(query.from, query.to, () => previousMonth(addisDay(new Date())));
    const thresholdPct = this.deps.settings.varianceThresholdPct;
    const scope = staffScope(caller);
    const reads = await this.deps.reads.session();
    const empty = { items: [], total: 0, summary: summarise([]), from, to, thresholdPct, freshness: reads.freshness() };

    // A filter naming something unknown, or outside the caller's depots, matches nothing: an empty page.
    let depotId: string | undefined;
    if (query.depot_id) {
      const found = await refs.depots.inScope(reads, query.depot_id, scope);
      if (!found) return empty;
      depotId = found;
    }
    const vehicles = await refs.vehicles.forReconciliation(reads, scope, { publicId: query.vehicle_id, depotId });
    // A retired vehicle with nothing in the period is not part of it; one named on purpose always is.
    const lines = (await this.lines(reads, vehicles, from, to)).filter((l) => query.vehicle_id || l.vehicle.isActive || l.usage.trips > 0 || l.usage.fuelLogs > 0);
    const flagged = await anomalies.forPeriod(reads, lines.map((l) => l.vehicle.id), from, to);

    const matching = lines.filter((l) => !query.status || l.judgement.status === query.status).sort(worstFirst);
    const start = (query.page - 1) * query.page_size;
    const items = matching.slice(start, start + query.page_size).map((l) => view(l, flagged.get(l.vehicle.id) ?? null));
    return { items, total: matching.length, summary: summarise(lines), from, to, thresholdPct, freshness: reads.freshness() };
  }

  /** A vehicle's fuel over a period (the 30 days to now by default). A vehicle outside the caller's depots is 404. */
  async summary(caller: Caller, vehiclePublicId: string, query: { from?: Date; to?: Date }): Promise<{ summary: FuelSummaryView; freshness: DataFreshness }> {
    const { refs, anomalies } = this.deps;
    const { from, to } = periodOf(query.from, query.to, () => {
      const now = new Date();
      return { from: new Date(now.getTime() - SUMMARY_DAYS * DAY_MS), to: now };
    });
    // A vehicle's totals include every driver's fill-ups; a driver reads only their own logs (FMS-39).
    if (ownDriverScope(caller.user).kind !== 'all') throw vehicleNotFound();
    const reads = await this.deps.reads.session();
    const [vehicle] = await refs.vehicles.forReconciliation(reads, depotScope(caller.user), { publicId: vehiclePublicId });
    if (!vehicle) throw vehicleNotFound();
    const thresholdPct = this.deps.settings.varianceThresholdPct;
    const [{ usage, judgement }] = await this.lines(reads, [vehicle], from, to, thresholdPct);
    const perKm = (amount: number) => (usage.distanceM > 0 ? roundDiv(amount * 1000, usage.distanceM) : null);
    const summary: FuelSummaryView = {
      vehicle_id: vehicle.publicId,
      from,
      to,
      fuel_logs: usage.fuelLogs,
      actual_ml: usage.actualMl,
      total_cost_cents: usage.costCents,
      trips: usage.trips,
      distance_km: kmOf(usage.distanceM),
      rated_efficiency_ml_per_km: vehicle.fuelEfficiencyMlPerKm,
      actual_efficiency_ml_per_km: perKm(usage.actualMl),
      expected_ml: judgement.expectedMl,
      variance_ml: judgement.varianceMl,
      variance_pct: judgement.variancePct,
      status: judgement.status,
      reason: judgement.reason,
      cost_per_km_cents: perKm(usage.costCents),
      average_price_cents_per_litre: usage.actualMl > 0 ? roundDiv(usage.costCents * 1000, usage.actualMl) : null,
      open_anomalies: await anomalies.openCount(reads, vehicle.id),
      threshold_pct: thresholdPct,
    };
    return { summary, freshness: reads.freshness() };
  }

  /**
   * The monthly reconciliation (job `fuel-reconciliation`): the calendar month before the run's day, every
   * vehicle. Each vehicle beyond the threshold gets one anomaly for the month and FuelAnomalyDetected, in one
   * transaction. The job runs daily: the first run of a month does the work; later ones add an anomaly only for a
   * vehicle that late fill-ups (logged up to 30 days after, FMS-115) or trips have since pushed over, and never a
   * second one for the same month.
   */
  async runMonthly(context: JobContext): Promise<Record<string, unknown>> {
    const started = Date.now();
    const { refs, anomalies, events } = this.deps;
    const { from, to } = previousMonth(context.runKey);
    const thresholdPct = this.deps.settings.varianceThresholdPct;
    const reads = await this.deps.reads.session();

    const vehicles = await refs.vehicles.forReconciliation(reads, { kind: 'all' });
    const lines = (await this.lines(reads, vehicles, from, to, thresholdPct)).filter((l) => l.vehicle.isActive || l.usage.trips > 0 || l.usage.fuelLogs > 0);
    const flagged = lines.filter((l) => l.judgement.status === 'above' || l.judgement.status === 'below');

    let created = 0;
    let already = 0;
    if (flagged.length > 0) {
      await anomalies.inTransaction(async (client) => {
        // Read on the primary, inside the transaction that writes: the unique index is the backstop.
        const existing = await anomalies.forPeriod(client, flagged.map((l) => l.vehicle.id), from, to);
        const ctx: MutationContext = { userId: null, correlationId: context.correlationId };
        const detected: DomainEvent[] = [];
        for (const { vehicle, usage, judgement } of flagged) {
          if (existing.has(vehicle.id)) {
            already += 1;
            continue;
          }
          const variancePct = judgement.variancePct!;
          const anomalyType = judgement.status === 'above' ? RECONCILIATION_ANOMALY.above : RECONCILIATION_ANOMALY.below;
          const severity = severityOf(variancePct, thresholdPct);
          const row = await anomalies.insertReconciliation(
            ctx,
            {
              vehicle_id: vehicle.id,
              anomaly_type: anomalyType,
              severity,
              period_start: from,
              period_end: to,
              distance_km: kmOf(usage.distanceM),
              expected_ml: judgement.expectedMl!,
              actual_ml: usage.actualMl,
              // ml per 100 km: the rating × 100, and the fuel logged over the distance (100,000 m).
              expected_consumption_ml_100km: vehicle.fuelEfficiencyMlPerKm! * 100,
              actual_consumption_ml_100km: roundDiv(usage.actualMl * 100_000, usage.distanceM),
              deviation_percentage: variancePct,
              detected_at: context.now,
            },
            client,
          );
          detected.push(
            createEvent(
              FUEL_EVENTS.anomalyDetected,
              {
                anomaly_id: row.public_id as string,
                vehicle_id: vehicle.publicId,
                driver_id: null,
                trip_id: null,
                fuel_log_id: null,
                anomaly_type: anomalyType,
                severity,
                period_from: from.toISOString(),
                period_to: to.toISOString(),
                distance_km: kmOf(usage.distanceM),
                expected_ml: judgement.expectedMl,
                actual_ml: usage.actualMl,
                deviation_pct: variancePct,
              },
              { actor: null, correlationId: context.correlationId },
              // One fact per vehicle and month, whichever run finds it.
              { id: deterministicEventId(`fuel-reconciliation:${vehicle.publicId}:${from.toISOString()}`), aggregate: aggregateKey('vehicle', vehicle.publicId) },
            ),
          );
          created += 1;
        }
        if (detected.length > 0) await events.publish(client, detected);
      });
    }

    const count = (status: ReconciliationStatus) => lines.filter((l) => l.judgement.status === status).length;
    return {
      period: addisDay(from).slice(0, 7),
      vehicles: lines.length,
      within: count('within'),
      above: count('above'),
      below: count('below'),
      not_judged: count('not_judged'),
      anomalies: created,
      already_flagged: already,
      threshold_pct: thresholdPct,
      // Where the month was read (FMS-94), and how far behind the primary it was.
      read_from: reads.freshness().source,
      replica_lag_seconds: reads.freshness().lag_seconds,
      duration_ms: Date.now() - started,
    };
  }

  /** Each vehicle's trips and fuel over [from, to), and its judgement. One query per source, for every vehicle at once. */
  private async lines(db: Queryable, vehicles: ReconciledVehicle[], from: Date, to: Date, thresholdPct = this.deps.settings.varianceThresholdPct): Promise<Line[]> {
    const ids = vehicles.map((v) => v.id);
    // One after another: they may share one connection.
    const trips = await this.deps.refs.trips.completedMetres(db, ids, from, to);
    const fuel = await this.deps.logs.usageBetween(db, ids, from, to);
    return vehicles.map((vehicle) => {
      const t = trips.get(vehicle.id) ?? { distanceM: 0, trips: 0 };
      const f = fuel.get(vehicle.id) ?? { actualMl: 0, fuelLogs: 0, costCents: 0 };
      const usage: VehicleUsage = { distanceM: t.distanceM, trips: t.trips, actualMl: f.actualMl, fuelLogs: f.fuelLogs, costCents: f.costCents };
      return { vehicle, usage, judgement: judge(vehicle, usage, thresholdPct) };
    });
  }
}

/**
 * The period asked for: both bounds, `from` alone (to now), `to` alone (the 30 days before it) or neither (the
 * fallback). `to` after `from`, at most MAX_PERIOD_DAYS.
 */
function periodOf(from: Date | undefined, to: Date | undefined, fallback: () => { from: Date; to: Date }): { from: Date; to: Date } {
  const period = !from && !to ? fallback() : { from: from ?? new Date(to!.getTime() - SUMMARY_DAYS * DAY_MS), to: to ?? new Date() };
  if (period.to.getTime() <= period.from.getTime()) throw periodReversed();
  if (period.to.getTime() - period.from.getTime() > MAX_PERIOD_DAYS * DAY_MS) throw periodTooLong();
  return period;
}

/** Staff see their depots; a caller placed nowhere (or a driver only) sees nothing. */
function staffScope(caller: Caller): Scope {
  return ownDriverScope(caller.user).kind === 'all' ? depotScope(caller.user) : { kind: 'none' };
}

/** Furthest from expected first, either way; not judged last; then by vehicle, for a stable page order. */
function worstFirst(a: Line, b: Line): number {
  const da = a.judgement.variancePct === null ? -1 : Math.abs(a.judgement.variancePct);
  const db = b.judgement.variancePct === null ? -1 : Math.abs(b.judgement.variancePct);
  return db - da || Number(BigInt(a.vehicle.id) - BigInt(b.vehicle.id));
}

function view({ vehicle, usage, judgement }: Line, anomalyId: string | null): ReconciliationView {
  return {
    vehicle_id: vehicle.publicId,
    depot_id: vehicle.depotPublicId,
    fuel_type: vehicle.fuelType,
    fuel_efficiency_ml_per_km: vehicle.fuelEfficiencyMlPerKm,
    distance_km: kmOf(usage.distanceM),
    trips: usage.trips,
    fuel_logs: usage.fuelLogs,
    expected_ml: judgement.expectedMl,
    actual_ml: usage.actualMl,
    variance_ml: judgement.varianceMl,
    variance_pct: judgement.variancePct,
    total_cost_cents: usage.costCents,
    status: judgement.status,
    reason: judgement.reason,
    anomaly_id: anomalyId,
  };
}

function summarise(lines: Line[]): ReconciliationSummary {
  const judged = lines.filter((l) => l.judgement.expectedMl !== null);
  const expected = judged.reduce((sum, l) => sum + l.judgement.expectedMl!, 0);
  const actual = judged.reduce((sum, l) => sum + l.usage.actualMl, 0);
  return {
    vehicles: lines.length,
    judged: judged.length,
    above: lines.filter((l) => l.judgement.status === 'above').length,
    below: lines.filter((l) => l.judgement.status === 'below').length,
    expected_ml: expected,
    actual_ml: actual,
    variance_pct: expected > 0 ? roundDiv((actual - expected) * 100, expected) : null,
    total_cost_cents: lines.reduce((sum, l) => sum + l.usage.costCents, 0),
  };
}
