import type { Queryable } from '../../../shared/infrastructure/queryable';
import {
  LONGEST_TRIP_HOURS,
  RECORD_DAYS,
  TRIP_RISK_ID_COLUMNS,
  TRIP_RISK_LABELS,
  TRIP_RISK_MINIMUM,
  csvCell,
  tripRiskFeatures,
  type RiskInput,
  type RiskJob,
  type RiskPast,
} from '../domain/trip-risk';
import type { RiskFactRow, TripRiskRepository } from '../infrastructure/trip-risk.repository';

const HOUR_MS = 3_600_000;
/** How long the model's status is trusted: the board polls, and a newly activated model shows within a minute. */
export const TRIP_RISK_STATUS_TTL_MS = 60_000;

/** The registry's answer (maintenance's tripRiskModels.check). */
type ModelCheck = { ok: true; version: string; demonstration: boolean } | { ok: false; reason: string; version: string | null };

/** The model's answer for one driver (maintenance's tripRiskModels.predict). */
interface ModelPrediction {
  driverId: string;
  lateProbability: number;
  safetyEventProbability: number;
  factors: { late: { feature: string; value: number }[]; safety_event: { feature: string; value: number }[] };
}

export interface TripRiskServiceDeps {
  reads: { session(): Promise<Queryable> };
  repo: TripRiskRepository;
  models: {
    check(correlationId: string): Promise<ModelCheck>;
    predict(items: { trip_id: string; driver_id: string; features: Record<string, number> }[], correlationId: string): Promise<ModelPrediction[]>;
    /** The inputs the extractor implements (trip_risk_spec.json). */
    spec(): { inputs: RiskInput[] };
  };
  /** The trip module's job load (FMS-153): its points and level for a trip. */
  jobLoad(input: {
    plannedDistanceKm: number | null;
    plannedDurationSeconds: number | null;
    scheduledStart: Date | null;
    scheduledEnd: Date | null;
    stopCount: number;
    cargoWeightKg: number | null;
    payloadCapacityKg: number | null;
  }): { level: string; points: number };
  nightHours(start: Date, end: Date): number;
  log: { warn(obj: object, msg: string): void };
  now?: () => Date;
}

/**
 * Whether the console shows the model's chances, and why not. `ok`: the active model, a demonstration when trained on
 * generated trips. `not_enough_trips`: no usable model, and too few real trips to train one (the console says "Not
 * enough trips yet"). `off`: no usable model for another reason (`reason`); `unavailable`: the ML service failed.
 */
export interface TripRiskSummary {
  status: 'ok' | 'not_enough_trips' | 'off' | 'unavailable';
  reason: string | null;
  model_version: string | null;
  demonstration: boolean;
  /** Completed, measured trips there are to train on, and their drivers; the least the model needs. */
  trips: number;
  drivers: number;
  minimum: { trips: number; drivers: number };
}

/** One driver's chances on the trip, and the two inputs that raise each most, with their values. */
export interface DriverTripRisk {
  late_probability: number;
  safety_event_probability: number;
  factors: { late: { feature: string; value: number }[]; safety_event: { feature: string; value: number }[] };
}

/** Converts a fact row to a past trip, its job load level worked out as the trip module does. */
type ToPast = (row: RiskFactRow) => RiskPast;

/**
 * The trip risk model on the dispatch console (FMS-155, docs/ml-trip-risk.md): each available driver's chance of the
 * trip running late and of a safety event, from the model the ML service serves once it is active. It informs one
 * trip's choice: it never blocks, ranks people, or shows to drivers. Reads the analytics views on the read replica.
 */
export class TripRiskService {
  private cached: { at: number; summary: TripRiskSummary } | null = null;

  constructor(private readonly deps: TripRiskServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Drops the cached status, so the next board asks again (tests; an activation shows within TRIP_RISK_STATUS_TTL_MS otherwise). */
  forget(): void {
    this.cached = null;
  }

  async status(correlationId: string): Promise<TripRiskSummary> {
    const at = this.now().getTime();
    if (this.cached && at - this.cached.at < TRIP_RISK_STATUS_TTL_MS) return this.cached.summary;
    const db = await this.deps.reads.session();
    const counts = await this.deps.repo.eligibleCounts(db);
    const check = await this.deps.models.check(correlationId);
    const base = { ...counts, minimum: { ...TRIP_RISK_MINIMUM } };
    const enough = counts.trips >= TRIP_RISK_MINIMUM.trips && counts.drivers >= TRIP_RISK_MINIMUM.drivers;
    const summary: TripRiskSummary = check.ok
      ? { status: 'ok', reason: null, model_version: check.version, demonstration: check.demonstration, ...base }
      : check.reason === 'unavailable'
        ? { status: 'unavailable', reason: 'unavailable', model_version: check.version, demonstration: false, ...base }
        : !enough
          ? { status: 'not_enough_trips', reason: check.reason, model_version: check.version, demonstration: false, ...base }
          : { status: 'off', reason: check.reason, model_version: check.version, demonstration: false, ...base };
    this.cached = { at, summary };
    return summary;
  }

  private toPast: ToPast = (row) => ({
    scheduledEnd: row.scheduledEnd,
    actualStart: row.actualStart!,
    actualEnd: row.actualEnd,
    late: row.late,
    safetyEvent: row.safetyEvent,
    jobLoadLevel: this.load(row).level,
  });

  private load(row: RiskFactRow) {
    return this.deps.jobLoad({
      plannedDistanceKm: row.plannedDistanceKm,
      plannedDurationSeconds: row.plannedDurationSeconds,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      stopCount: row.stopCount,
      cargoWeightKg: row.cargoWeightKg,
      payloadCapacityKg: row.payloadCapacityKg,
    });
  }

  /** The trip as the model takes it, at t: its scheduled start, else now. */
  private job(row: RiskFactRow, t: Date): RiskJob {
    const load = this.load({ ...row, scheduledStart: row.scheduledStart ?? t });
    const end = row.scheduledEnd;
    return {
      scheduledStart: t,
      scheduledEnd: end,
      plannedDistanceKm: row.plannedDistanceKm,
      plannedDurationSeconds: row.plannedDurationSeconds,
      stops: row.stopCount,
      cargoWeightKg: row.cargoWeightKg,
      cargoKind: row.cargoKind,
      payloadCapacityKg: row.payloadCapacityKg,
      jobLoadPoints: load.points,
      jobLoadLevel: load.level,
      nightHours: end && end > t ? this.deps.nightHours(t, end) : 0,
    };
  }

  /**
   * For GET /dispatch/availability with a trip (FMS-155): the summary, and each driver's chances when the model may be
   * asked. `driverPublicIds` are the drivers free for the trip: blocked ones get none. Never throws for the model: an ML
   * service that fails makes the summary `unavailable`, and the console keeps the rules.
   */
  async forTrip(tripPublicId: string, driverPublicIds: readonly string[], correlationId: string): Promise<{ summary: TripRiskSummary; drivers: Map<string, DriverTripRisk> }> {
    const summary = await this.status(correlationId);
    const drivers = new Map<string, DriverTripRisk>();
    if (summary.status !== 'ok' || driverPublicIds.length === 0) return { summary, drivers };
    const db = await this.deps.reads.session();
    const trip = await this.deps.repo.trip(db, tripPublicId);
    if (!trip) return { summary, drivers };
    const t = trip.scheduledStart ?? this.now();
    const job = this.job(trip, t);
    const rows = await this.deps.repo.history(db, {
      driverPublicIds,
      routeId: trip.routeId,
      from: new Date(t.getTime() - (RECORD_DAYS * 24 + LONGEST_TRIP_HOURS) * HOUR_MS),
      to: t,
    });
    const others = rows.filter((r) => r.publicId !== trip.publicId);
    const route = others.filter((r) => trip.routeId !== null && r.routeId === trip.routeId).map(this.toPast);
    const inputs = this.deps.models.spec().inputs;
    const items = driverPublicIds.map((driver) => ({
      trip_id: trip.publicId,
      driver_id: driver,
      features: tripRiskFeatures(job, others.filter((r) => r.driverPublicId === driver).map(this.toPast), route, inputs),
    }));
    try {
      for (const p of await this.deps.models.predict(items, correlationId)) {
        drivers.set(p.driverId, { late_probability: p.lateProbability, safety_event_probability: p.safetyEventProbability, factors: p.factors });
      }
    } catch (err) {
      this.deps.log.warn({ err: err instanceof Error ? err.message : String(err), trip_id: trip.publicId }, 'trip risk: the ML service could not score; the console keeps the rules');
      return { summary: { ...summary, status: 'unavailable', reason: 'unavailable' }, drivers: new Map() };
    }
    return { summary, drivers };
  }

  /**
   * The training dataset (npm run ml:trip-risk-dataset): every eligible trip with its inputs as of its scheduled start and
   * its labels, as CSV in trip_risk_spec.json's columns, source `fleet`. Inputs come from every trip that had started.
   */
  async dataset(): Promise<{ csv: string; trips: number; drivers: number }> {
    const db = await this.deps.reads.session();
    const rows = await this.deps.repo.started(db);
    const inputs = this.deps.models.spec().inputs;
    const byDriver = new Map<string, RiskFactRow[]>();
    const byRoute = new Map<string, RiskFactRow[]>();
    const add = (map: Map<string, RiskFactRow[]>, key: string, row: RiskFactRow) => {
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    };
    for (const r of rows) {
      if (r.driverPublicId) add(byDriver, r.driverPublicId, r);
      if (r.routeId) add(byRoute, r.routeId, r);
    }
    const header = [...TRIP_RISK_ID_COLUMNS, ...inputs.map((i) => i.name), ...TRIP_RISK_LABELS];
    const lines = [header.join(',')];
    const drivers = new Set<string>();
    for (const r of rows) {
      if (!r.eligible) continue;
      const t = r.scheduledStart!;
      const from = t.getTime() - (RECORD_DAYS * 24 + LONGEST_TRIP_HOURS) * HOUR_MS;
      const near = (list: RiskFactRow[] | undefined) =>
        (list ?? []).filter((p) => p.publicId !== r.publicId && p.actualStart! < t && (p.actualEnd === null || p.actualEnd.getTime() >= from)).map(this.toPast);
      const features = tripRiskFeatures(this.job(r, t), near(byDriver.get(r.driverPublicId!)), near(r.routeId ? byRoute.get(r.routeId) : undefined), inputs);
      drivers.add(r.driverPublicId!);
      const ids = [r.publicId, r.driverPublicId!, r.depotPublicId ?? 'none', t.toISOString().replace(/\.\d{3}Z$/, 'Z'), 'fleet'];
      lines.push([...ids, ...inputs.map((i) => features[i.name]), r.late ? 1 : 0, r.safetyEvent ? 1 : 0].map(csvCell).join(','));
    }
    return { csv: `${lines.join('\n')}\n`, trips: lines.length - 1, drivers: drivers.size };
  }
}
