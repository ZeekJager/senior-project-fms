import { AppError } from '../../../shared/errors/app-error';
import { depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DataFreshness, ReadSession } from '../../../shared/infrastructure/read-router';
import type { RequestUser } from '../../../types/express';
import { addTotals, downtimeKpis, monthWindow, NO_TOTALS, vehicleTotals, type DowntimeFact, type DowntimeTotals, type ServiceSpan } from '../domain/downtime';
import { NO_FILTERS, resolvePeriod, type PeriodQuery, type ReportFilters, type ReportPeriod, type ResolvedFilters } from '../domain/report-period';
import {
  MIN_SCORED_TRIPS,
  rankDrivers,
  SCORE_COMPONENTS,
  scoreDriver,
  type DriverScore,
  type ScoreComponent,
  type ScoreReason,
  type ScoreWeights,
} from '../domain/driver-score';
import {
  centsPerKm,
  formatAddisDateTime,
  formatValue,
  FUEL_TYPE_WORDS,
  isNumeric,
  mlPerKmDriven,
  per100kKm,
  percent,
  REPORTS,
  toCsv,
  tripStatusWord,
  type ReportColumn,
  type ReportFormat,
  type ReportKind,
  type ReportRow,
  type ReportSection,
  type SafetyGroup,
} from '../domain/reports';

const DAY_MS = 86_400_000;
/** The downtime causes, as fleet stores them (fleet.downtime_reason). */
const DOWNTIME_CAUSES = ['planned_service', 'unplanned_repair', 'breakdown', 'accident', 'awaiting_parts', 'other'] as const;
import type { Audience } from '../infrastructure/analytics.repository';
import type { DriverRow, FilterNames, ReportRepository } from '../infrastructure/report.repository';
import { renderTablePdf } from '../infrastructure/table-pdf';

export interface ReportQuery extends PeriodQuery, ReportFilters {
  /** One depot (FMS-91's filter); depot_ids takes several (FMS-160). */
  depot_id?: string;
  /** Safety's grouping (FMS-160). */
  by?: SafetyGroup;
}

/** A report as GET /reports/{report} returns it (format json), and what the CSV and PDF are written from. */
export interface ReportData {
  report: ReportKind;
  title: string;
  /** The month, for a period that is one (FMS-91); null for a quarter, a year or a range. */
  month: string | null;
  /** The period as instants, [from, to): up to now for the current one; and how it was asked for (FMS-160). */
  period: { from: string; to: string; kind: ReportPeriod['kind']; key: string; label: string; first_day: string; last_day: string };
  /** The filters applied, by public id (FMS-160). */
  filters: ReportFilters;
  /** What the filters name (FMS-160): the depots, the vehicle's registration, the driver, the route. */
  filter_names: FilterNames;
  /** Safety's grouping. */
  group?: SafetyGroup;
  /** Extra tables (maintenance compliance's cost by system and by vendor). */
  sections?: ReportSection[];
  /** The depot chosen; null for every depot in the caller's scope. */
  depot: { id: string; name: string; code: string } | null;
  columns: readonly ReportColumn[];
  rows: ReportRow[];
  /** Sums and overall ratios; null when there are no rows. */
  totals: ReportRow | null;
  generated_at: string;
}

export interface ReportFile {
  filename: string;
  contentType: string;
  body: Buffer | string;
}

export interface ReportServiceDeps {
  reads: { session(): Promise<ReadSession> };
  repo: ReportRepository;
  /** Downtime and service spans (FMS-131), for the utilisation report. */
  downtime?: {
    serviceSpans(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, ServiceSpan>>;
    downtimeFacts(db: Queryable, vehicleIds: readonly string[], from: Date, to: Date): Promise<Map<string, Omit<DowntimeFact, 'unplanned'>[]>>;
    isUnplanned(reason: string): boolean;
  };
  /** Excel and the Unicode PDF (FMS-160, ADR-11). */
  writers?: { xlsx(doc: ReportDocument): Promise<Buffer>; pdf(doc: ReportDocument): Promise<Buffer> };
  /** The driver score's weights (FMS-146): the settings', as an administrator left them. */
  weights: () => Promise<ScoreWeights>;
  /** The approved appeals that corrected a driver's month (FMS-159), for "Corrected after appeal". */
  corrections?: (db: Queryable, driverUserId: string, month: string) => Promise<ScoreCorrection[]>;
  now?: () => Date;
}

/** An approved appeal that corrected a driver's month (FMS-159): the score before and after. */
export interface ScoreCorrection {
  appeal_id: string;
  correction: string | null;
  score_before: number | null;
  score_after: number | null;
  decided_at: string | null;
}

/** Behavioural data (the driver score and its ranking) is for the roles that may follow vehicles (FMS-146). */
export const SCORE_PERMISSION = 'tracking:read';
const seesScores = (user: RequestUser | undefined) => user?.permissions.includes(SCORE_PERMISSION) ?? false;

/** Why a driver has no score, as a report cell. */
const NO_SCORE_WORDS: Record<ScoreReason, string> = { not_enough_trips: 'Not enough trips', nothing_to_judge: 'Nothing to judge' };

/** A driver in the ranking (GET /analytics/driver-ranking). */
export interface RankedDriver {
  driver_id: string;
  name: string;
  depot: string;
  rank: number;
  score: number;
  /** Each component, 0 to 100; null when it could not be judged. */
  components: Record<ScoreComponent, number | null>;
  trips_completed: number;
}

/** GET /analytics/driver-ranking (FMS-146): the month's scored drivers in rank order, and how many had no score. */
export interface DriverRanking {
  month: string;
  period: { from: string; to: string };
  depot: ReportData['depot'];
  weights: ScoreWeights;
  drivers: RankedDriver[];
  /** Drivers active in the month with no score: fewer than MIN_SCORED_TRIPS trips, or nothing to judge. */
  unscored: number;
  min_trips: number;
  generated_at: string;
}

/** GET /analytics/my-performance (FMS-146): a driver's own score, its components and what they were worked out from. */
export interface OwnPerformance {
  month: string;
  period: { from: string; to: string };
  score: number | null;
  reason: ScoreReason | null;
  min_trips: number;
  trips_completed: number;
  distance_m: number;
  components: {
    punctuality: { score: number | null; weight: number; trips_timed: number; trips_on_time: number };
    safety: { score: number | null; weight: number; speeding: number; idling: number };
    incidents: { score: number | null; weight: number; accidents: number };
    dvir: { score: number | null; weight: number; trips_inspected: number };
  };
  /** Approved appeals that corrected this month, oldest first (FMS-159): the card shows "Corrected after appeal". */
  corrections: ScoreCorrection[];
  generated_at: string;
}

const FILE_NAMES: Record<ReportKind, string> = {
  fuel: 'fuel-report',
  maintenance: 'maintenance-report',
  cost: 'cost-report',
  trips: 'trip-history',
  drivers: 'driver-performance',
  utilisation: 'utilisation-report',
  compliance: 'maintenance-compliance',
  safety: 'safety-report',
};

/** What the Excel and PDF writers take: the report and the lines that say what it covers (FMS-160). */
export interface ReportDocument {
  title: string;
  subtitle: string;
  filterLines: string[];
  columns: readonly ReportColumn[];
  rows: readonly ReportRow[];
  totals: ReportRow | null;
  sections: readonly ReportSection[];
  footer: string;
}

/** Exports larger than this run in the background (FMS-160). */
export const BACKGROUND_EXPORT_ROWS = 20_000;

const sum = <T>(rows: readonly T[], pick: (r: T) => number) => rows.reduce((total, r) => total + pick(r), 0);
const plural = (count: number, kind: ReportKind) => `${count.toLocaleString('en-US')} ${count === 1 ? REPORTS[kind].rowNoun.one : REPORTS[kind].rowNoun.many}`;

/**
 * Monthly reports and exports (FMS-91, docs/reports.md): fuel, maintenance and cost per vehicle, the trip history
 * and driver performance, for a calendar month in Addis Ababa and the caller's depots (or one of them), read from the
 * analytics views on the read replica. The same table goes out as JSON for the screen, CSV and PDF. analytics:read;
 * a driver sees nothing.
 */
export class ReportService {
  private readonly now: () => Date;

  constructor(private readonly deps: ReportServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The period, the read session, the caller's audience and the filters resolved within it. A depot, vehicle, driver or
   * route that is unknown or outside the caller's depots matches nothing: an empty report, as a filter does elsewhere.
   */
  private async scoped(user: RequestUser | undefined, query: ReportQuery) {
    const period = resolvePeriod(query, this.now());
    const db = await this.deps.reads.session();
    const a: Audience = { scope: staffScope(user) };
    let depot: ReportData['depot'] = null;
    const asked: ReportFilters = {
      ...(query.depot_ids?.length ? { depot_ids: query.depot_ids } : {}),
      ...(query.vehicle_type ? { vehicle_type: query.vehicle_type } : {}),
      ...(query.vehicle_id ? { vehicle_id: query.vehicle_id } : {}),
      ...(query.driver_id ? { driver_id: query.driver_id } : {}),
      ...(query.route_id ? { route_id: query.route_id } : {}),
    };
    if (query.depot_id) {
      const found = await this.deps.repo.depot(db, query.depot_id, a);
      if (found) {
        a.depotId = found.id;
        depot = { id: query.depot_id, name: found.name, code: found.code };
      } else a.scope = { kind: 'none' };
    }
    const resolved = a.scope.kind === 'none' ? NO_FILTERS : await this.deps.repo.resolveFilters(db, a, asked);
    // A filter naming a depot, vehicle, driver or route outside the caller's scope (or none at all) is 404, as the
    // record itself would be; the answer never echoes it.
    if (resolved === false) throw new AppError(404, 'NOT_FOUND', 'A filter names a depot, vehicle, driver or route that was not found.');
    const filters: ResolvedFilters = resolved;
    // The month window, for the callers that take one (the ranking, a driver's own score).
    const w = { month: period.month ?? period.key, start: period.start, end: period.end };
    return { period, w, db, a, depot, filters, asked };
  }

  async report(kind: ReportKind, user: RequestUser | undefined, query: ReportQuery): Promise<{ data: ReportData; meta: { data_freshness: DataFreshness } }> {
    const { period, db, a, depot, filters, asked } = await this.scoped(user, query);
    const group: SafetyGroup = query.by ?? 'depot';
    const { rows, totals, sections } = await this.build(kind, db, a, period.start, period.end, seesScores(user), filters, group);
    // The driver score and rank only for the roles allowed behavioural data (FMS-146).
    let columns = kind === 'drivers' && !seesScores(user) ? REPORTS[kind].columns.filter((c) => c.key !== 'rank' && c.key !== 'score') : REPORTS[kind].columns;
    if (kind === 'safety') columns = columns.map((c) => (c.key === 'name' ? { ...c, label: group === 'driver' ? 'Driver' : group === 'route' ? 'Route' : 'Depot' } : c));
    return {
      data: {
        report: kind,
        title: REPORTS[kind].title,
        month: period.month,
        period: { from: period.start.toISOString(), to: period.end.toISOString(), kind: period.kind, key: period.key, label: period.label, first_day: period.from, last_day: period.to },
        filters: { ...asked, ...(query.depot_id ? { depot_ids: [query.depot_id, ...(asked.depot_ids ?? [])] } : {}) },
        filter_names: await this.deps.repo.filterNames(db, filters),
        ...(kind === 'safety' ? { group } : {}),
        ...(sections?.length ? { sections } : {}),
        depot,
        columns,
        rows,
        totals: rows.length > 0 ? totals : null,
        generated_at: this.now().toISOString(),
      },
      meta: { data_freshness: db.freshness() },
    };
  }

  /** For the KPIs (FMS-160): vehicles at risk now, and the period's appeals and feedback, as the filters narrow them. */
  async counts(user: RequestUser | undefined, query: ReportQuery, healthLine: number): Promise<{ vehiclesAtRisk: number; appeals: number; feedback: number }> {
    const { period, db, a, filters } = await this.scoped(user, query);
    const vehiclesAtRisk = await this.deps.repo.vehiclesAtRisk(db, a, healthLine, filters);
    const { appeals, feedback } = await this.deps.repo.appealsAndFeedback(db, a, period.start, period.end, filters);
    return { vehiclesAtRisk, appeals, feedback };
  }

  /** The report as a file to download: CSV, Excel or PDF. */
  async file(kind: ReportKind, format: Exclude<ReportFormat, 'json'>, user: RequestUser | undefined, query: ReportQuery): Promise<ReportFile> {
    const { data, meta } = await this.report(kind, user, query);
    return this.render(data, format, meta.data_freshness);
  }

  /** A report already built, as a file: its name says the report, the period and the depot. */
  async render(data: ReportData, format: Exclude<ReportFormat, 'json'>, freshness: DataFreshness): Promise<ReportFile> {
    const kind = data.report;
    const where = (data.depot?.code ?? (data.filters.depot_ids?.length ? 'filtered' : 'all')).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'depot';
    const filename = `${FILE_NAMES[kind]}-${data.period.key.split('..').join('_to_')}-${where}.${format}`;
    if (format === 'csv') return { filename, contentType: 'text/csv; charset=utf-8', body: toCsv(data.columns, data.rows, data.totals) };
    const doc: ReportDocument = {
      title: `${data.title}, ${data.period.label}`,
      subtitle: subtitle(data, freshness, this.now()),
      filterLines: filterLines(data),
      columns: data.columns,
      rows: data.rows,
      totals: data.totals,
      sections: data.sections ?? [],
      footer: `${data.title}, ${data.period.label} · ${plural(data.rows.length, kind)}`,
    };
    if (format === 'xlsx') {
      if (!this.deps.writers) throw new Error('No Excel writer is set up.');
      return { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: await this.deps.writers.xlsx(doc) };
    }
    if (this.deps.writers) return { filename, contentType: 'application/pdf', body: await this.deps.writers.pdf(doc) };
    const cells = (row: ReportRow) => data.columns.map((c) => formatValue(c.kind, row[c.key] ?? null, { grouped: true }));
    return {
      filename,
      contentType: 'application/pdf',
      body: renderTablePdf({
        title: doc.title,
        subtitle: doc.subtitle,
        columns: data.columns.map((c) => ({ label: c.label, align: isNumeric(c.kind) ? 'right' : 'left' })),
        rows: data.rows.map(cells),
        totals: data.totals ? cells(data.totals) : null,
        footer: doc.footer,
      }),
    };
  }

  /**
   * GET /analytics/driver-ranking (FMS-146): every driver of the caller's depots (or the one chosen) scored for the
   * month, in rank order, and how many were active with no score. analytics:read and tracking:read.
   */
  async driverRanking(user: RequestUser | undefined, query: ReportQuery): Promise<{ data: DriverRanking; meta: { data_freshness: DataFreshness } }> {
    const { w, db, a, depot } = await this.scoped(user, query);
    const weights = await this.deps.weights();
    const found = await this.deps.repo.drivers(db, a, w.start, w.end);
    const ranked = rankDrivers(found.map((r) => ({ r, ...flatScore(scoreDriver(r, weights)), name: r.driver })));
    const drivers = ranked.flatMap(({ row, rank }) =>
      rank === null
        ? []
        : [{ driver_id: row.r.driverId, name: row.name, depot: row.r.depot, rank, score: row.score!, components: row.components, trips_completed: row.r.tripsCompleted }],
    );
    return {
      data: {
        month: w.month,
        period: { from: w.start.toISOString(), to: w.end.toISOString() },
        depot,
        weights,
        drivers,
        unscored: found.length - drivers.length,
        min_trips: MIN_SCORED_TRIPS,
        generated_at: this.now().toISOString(),
      },
      meta: { data_freshness: db.freshness() },
    };
  }

  /**
   * GET /analytics/my-performance (FMS-146): the signed-in driver's own score for the month and its components, never
   * anyone else's and never a rank. Null when the caller is not a driver.
   */
  async ownPerformance(user: RequestUser | undefined, query: { month?: string }): Promise<{ data: OwnPerformance; meta: { data_freshness: DataFreshness } } | null> {
    if (!user || user.id === null || !user.roles.includes('driver')) return null;
    const w = monthWindow(query.month, this.now());
    const db = await this.deps.reads.session();
    const weights = await this.deps.weights();
    const [row] = await this.deps.repo.drivers(db, { scope: { kind: 'all' } }, w.start, w.end, user.id);
    // A month with nothing done: no row, and no score.
    const m = row ?? { tripsCompleted: 0, distanceM: 0, tripsTimed: 0, tripsOnTime: 0, speeding: 0, idling: 0, accidents: 0, tripsInspected: 0 };
    const s = scoreDriver(m, weights);
    const c = s.components;
    return {
      data: {
        month: w.month,
        period: { from: w.start.toISOString(), to: w.end.toISOString() },
        score: s.score,
        reason: s.reason,
        min_trips: MIN_SCORED_TRIPS,
        trips_completed: m.tripsCompleted,
        distance_m: m.distanceM,
        components: {
          punctuality: { ...c.punctuality, trips_timed: m.tripsTimed, trips_on_time: m.tripsOnTime },
          safety: { ...c.safety, speeding: m.speeding, idling: m.idling },
          incidents: { ...c.incidents, accidents: m.accidents },
          dvir: { ...c.dvir, trips_inspected: m.tripsInspected },
        },
        corrections: this.deps.corrections ? await this.deps.corrections(db, user.id, w.month) : [],
        generated_at: this.now().toISOString(),
      },
      meta: { data_freshness: db.freshness() },
    };
  }

  private async build(
    kind: ReportKind,
    db: ReadSession,
    a: Audience,
    start: Date,
    end: Date,
    scores = false,
    f: ResolvedFilters = NO_FILTERS,
    group: SafetyGroup = 'depot',
  ): Promise<{ rows: ReportRow[]; totals: ReportRow; sections?: ReportSection[] }> {
    const { repo } = this.deps;
    switch (kind) {
      case 'utilisation':
        return this.utilisation(db, a, start, end, f);
      case 'compliance':
        return this.compliance(db, a, start, end, f);
      case 'safety':
        return this.safety(db, a, start, end, f, group);
      case 'fuel': {
        const found = await repo.fuel(db, a, start, end, f);
        const rows = found.map((r) => ({
          registration_number: r.registrationNumber,
          depot: r.depot,
          fuel_type: FUEL_TYPE_WORDS[r.fuelType] ?? r.fuelType,
          fill_ups: r.fillUps,
          fuel_ml: r.fuelMl,
          fuel_cost_cents: r.fuelCostCents,
          distance_m: r.distanceM,
          // An electric vehicle's fuel, if any is logged, says nothing of what it uses.
          consumption_ml_per_km: r.fuelType === 'electric' ? null : mlPerKmDriven(r.fuelMl, r.distanceM),
          rated_ml_per_km: r.fuelType === 'electric' ? null : r.ratedMlPerKm,
          cost_per_km_cents: centsPerKm(r.fuelCostCents, r.distanceM),
        }));
        const burning = found.filter((r) => r.fuelType !== 'electric');
        return {
          rows,
          totals: {
            registration_number: 'Total',
            depot: plural(found.length, kind),
            fuel_type: null,
            fill_ups: sum(found, (r) => r.fillUps),
            fuel_ml: sum(found, (r) => r.fuelMl),
            fuel_cost_cents: sum(found, (r) => r.fuelCostCents),
            distance_m: sum(found, (r) => r.distanceM),
            consumption_ml_per_km: mlPerKmDriven(
              sum(burning, (r) => r.fuelMl),
              sum(burning, (r) => r.distanceM),
            ),
            rated_ml_per_km: null,
            cost_per_km_cents: centsPerKm(
              sum(found, (r) => r.fuelCostCents),
              sum(found, (r) => r.distanceM),
            ),
          },
        };
      }
      case 'maintenance': {
        const found = await repo.maintenance(db, a, start, end, f);
        return {
          rows: found.map((r) => ({
            registration_number: r.registrationNumber,
            depot: r.depot,
            completed: r.completed,
            preventive: r.preventive,
            corrective: r.corrective,
            other: r.other,
            open: r.open,
            labour_minutes: r.labourMinutes,
            cost_cents: r.costCents,
          })),
          totals: {
            registration_number: 'Total',
            depot: plural(found.length, kind),
            completed: sum(found, (r) => r.completed),
            preventive: sum(found, (r) => r.preventive),
            corrective: sum(found, (r) => r.corrective),
            other: sum(found, (r) => r.other),
            open: sum(found, (r) => r.open),
            labour_minutes: sum(found, (r) => r.labourMinutes),
            cost_cents: sum(found, (r) => r.costCents),
          },
        };
      }
      case 'cost': {
        const found = await repo.cost(db, a, start, end, f);
        const total = (r: { fuelCostCents: number; maintenanceCostCents: number }) => r.fuelCostCents + r.maintenanceCostCents;
        return {
          rows: found.map((r) => ({
            registration_number: r.registrationNumber,
            depot: r.depot,
            distance_m: r.distanceM,
            fuel_cost_cents: r.fuelCostCents,
            maintenance_cost_cents: r.maintenanceCostCents,
            total_cost_cents: total(r),
            cost_per_km_cents: centsPerKm(total(r), r.distanceM),
          })),
          totals: {
            registration_number: 'Total',
            depot: plural(found.length, kind),
            distance_m: sum(found, (r) => r.distanceM),
            fuel_cost_cents: sum(found, (r) => r.fuelCostCents),
            maintenance_cost_cents: sum(found, (r) => r.maintenanceCostCents),
            total_cost_cents: sum(found, total),
            cost_per_km_cents: centsPerKm(
              sum(found, total),
              sum(found, (r) => r.distanceM),
            ),
          },
        };
      }
      case 'trips': {
        const found = await repo.trips(db, a, start, end, f);
        const judged = found.filter((r) => r.onTime !== null);
        const onTime = percent(judged.filter((r) => r.onTime).length, judged.length);
        return {
          rows: found.map((r) => ({
            scheduled_start: r.scheduledStart?.toISOString() ?? null,
            route: r.routeName ?? ([r.origin, r.destination].some(Boolean) ? `${r.origin ?? '?'} – ${r.destination ?? '?'}` : null),
            registration_number: r.registrationNumber,
            driver: r.driver,
            status: tripStatusWord(r.status),
            actual_start: r.actualStart?.toISOString() ?? null,
            actual_end: r.actualEnd?.toISOString() ?? null,
            planned_distance_m: r.plannedDistanceM,
            actual_distance_m: r.actualDistanceM,
            on_time: r.onTime === null ? null : r.onTime ? 'Yes' : 'No',
          })),
          totals: {
            scheduled_start: null,
            route: `Total: ${plural(found.length, kind)}`,
            registration_number: null,
            driver: null,
            status: `${found.filter((r) => r.status === 'completed').length.toLocaleString('en-US')} completed`,
            actual_start: null,
            actual_end: null,
            planned_distance_m: sum(found, (r) => r.plannedDistanceM ?? 0),
            actual_distance_m: sum(found, (r) => r.actualDistanceM ?? 0),
            on_time: onTime === null ? null : `${onTime}%`,
          },
        };
      }
      case 'drivers': {
        const found = await repo.drivers(db, a, start, end, undefined, f);
        // With the score (FMS-146), drivers in rank order, those with no score after them; without it, most trips first.
        const weights = scores ? await this.deps.weights() : null;
        const ranked: { row: { r: DriverRow; score: number | null; reason: ScoreReason | null }; rank: number | null }[] = weights
          ? rankDrivers(found.map((r) => ({ r, ...flatScore(scoreDriver(r, weights)), name: r.driver })))
          : found.map((r) => ({ row: { r, score: null, reason: null }, rank: null }));
        return {
          rows: ranked.map(({ row: { r, score, reason }, rank }) => ({
            ...(weights ? { rank, score: score ?? (reason ? NO_SCORE_WORDS[reason] : null) } : {}),
            driver: r.driver,
            depot: r.depot,
            trips_completed: r.tripsCompleted,
            distance_m: r.distanceM,
            driving_minutes: r.drivingMinutes,
            on_time_pct: percent(r.tripsOnTime, r.tripsTimed),
            speeding: r.speeding,
            idling: r.idling,
            incidents: r.incidents,
          })),
          totals: {
            ...(weights ? { rank: null, score: null } : {}),
            driver: 'Total',
            depot: plural(found.length, kind),
            trips_completed: sum(found, (r) => r.tripsCompleted),
            distance_m: sum(found, (r) => r.distanceM),
            driving_minutes: sum(found, (r) => r.drivingMinutes),
            on_time_pct: percent(
              sum(found, (r) => r.tripsOnTime),
              sum(found, (r) => r.tripsTimed),
            ),
            speeding: sum(found, (r) => r.speeding),
            idling: sum(found, (r) => r.idling),
            incidents: sum(found, (r) => r.incidents),
          },
        };
      }
    }
  }
  /** FMS-160: each vehicle's days in the fleet, available and in use, its downtime by cause, and its availability. */
  private async utilisation(db: ReadSession, a: Audience, start: Date, end: Date, f: ResolvedFilters): Promise<{ rows: ReportRow[]; totals: ReportRow }> {
    const { repo } = this.deps;
    const down = this.deps.downtime;
    if (!down) throw new Error('No downtime source is set up.');
    const vehicles = await repo.vehiclesInPeriod(db, a, start, end, f);
    const ids = vehicles.map((v) => v.vehicleId);
    const spans = await down.serviceSpans(db, ids);
    const facts = await down.downtimeFacts(db, ids, start, end);
    const inUse = await repo.daysInUse(db, ids, start, end, f);
    const window = { month: '', start, end };
    let all: DowntimeTotals = { ...NO_TOTALS, byReasonMs: {} };
    let daysInUseTotal = 0;
    const row = (label: { registration_number: string; depot: string }, t: DowntimeTotals, daysInUse: number): ReportRow => {
      const k = downtimeKpis(t, DOWNTIME_CAUSES);
      const inFleetDays = Math.round(t.inFleetMs / DAY_MS);
      const availableDays = Math.round((t.inFleetMs - t.downtimeMs) / DAY_MS);
      const used = Math.min(daysInUse, inFleetDays);
      return {
        ...label,
        days_in_fleet: inFleetDays,
        days_available: availableDays,
        days_in_use: used,
        utilisation_pct: percent(used, availableDays),
        downtime_minutes: k.downtime_minutes,
        planned_service_minutes: k.downtime_by_reason.planned_service ?? 0,
        unplanned_repair_minutes: k.downtime_by_reason.unplanned_repair ?? 0,
        breakdown_minutes: k.downtime_by_reason.breakdown ?? 0,
        accident_minutes: k.downtime_by_reason.accident ?? 0,
        awaiting_parts_minutes: k.downtime_by_reason.awaiting_parts ?? 0,
        other_minutes: k.downtime_by_reason.other ?? 0,
        availability_pct: percent(t.inFleetMs - t.downtimeMs, t.inFleetMs),
      };
    };
    const rows: ReportRow[] = [];
    for (const v of vehicles) {
      const span = spans.get(v.vehicleId);
      if (!span) continue;
      const periods = (facts.get(v.vehicleId) ?? []).map((x) => ({ ...x, unplanned: down.isUnplanned(x.reason) }));
      const t = vehicleTotals(span, periods, window);
      if (!t) continue;
      const days = inUse.get(v.vehicleId) ?? 0;
      all = addTotals(all, t);
      daysInUseTotal += Math.min(days, Math.round(t.inFleetMs / DAY_MS));
      rows.push(row({ registration_number: v.registrationNumber, depot: v.depot }, t, days));
    }
    const totals = row({ registration_number: 'Total', depot: plural(rows.length, 'utilisation') }, all, daysInUseTotal);
    return { rows, totals: { ...totals, days_in_use: daysInUseTotal, utilisation_pct: percent(daysInUseTotal, Number(totals.days_available)) } };
  }

  /** FMS-160: programmed services on time, late and overdue; corrective and repeat repairs; MTBF; cost by system and vendor. */
  private async compliance(db: ReadSession, a: Audience, start: Date, end: Date, f: ResolvedFilters): Promise<{ rows: ReportRow[]; totals: ReportRow; sections: ReportSection[] }> {
    const { repo } = this.deps;
    const found = await repo.compliance(db, a, start, end, f);
    const vehicles = await repo.vehiclesInPeriod(db, a, start, end, f);
    const spans = this.deps.downtime ? await this.deps.downtime.serviceSpans(db, vehicles.map((v) => v.vehicleId)) : new Map<string, ServiceSpan>();
    const fleetMinutes = new Map(
      vehicles.map((v) => {
        const span = spans.get(v.vehicleId);
        const from = span && span.joinedAt > start ? span.joinedAt : start;
        const to = span?.retiredAt && span.retiredAt < end ? span.retiredAt : end;
        return [v.registrationNumber, Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000))];
      }),
    );
    const mtbf = (minutes: number, failures: number) => (failures > 0 ? Math.round(minutes / failures) : null);
    const rows = found.map((r) => ({
      registration_number: r.registrationNumber,
      depot: r.depot,
      pm_on_time: r.pmOnTime,
      pm_late: r.pmLate,
      pm_overdue: r.pmOverdue,
      pm_compliance_pct: percent(r.pmOnTime, r.pmOnTime + r.pmLate + r.pmOverdue),
      corrective: r.corrective,
      repeat_repairs: r.repeatRepairs,
      unplanned_failures: r.unplannedFailures,
      mtbf_minutes: mtbf(fleetMinutes.get(r.registrationNumber) ?? 0, r.unplannedFailures),
      cost_cents: r.costCents,
    }));
    const onTime = sum(found, (r) => r.pmOnTime);
    const late = sum(found, (r) => r.pmLate);
    const overdue = sum(found, (r) => r.pmOverdue);
    const failures = sum(found, (r) => r.unplannedFailures);
    const breakdown = async (by: 'component' | 'workshop', title: string, label: string): Promise<ReportSection> => ({
      title,
      columns: [
        { key: 'name', label, kind: 'text' },
        { key: 'repairs', label: 'Repairs', kind: 'count' },
        { key: 'cost_cents', label: 'Cost (ETB)', kind: 'etb' },
      ],
      rows: (await repo.costBy(db, a, start, end, by, f)).map((r) => ({ name: r.key || (by === 'component' ? 'Not recorded' : 'No workshop'), repairs: r.repairs, cost_cents: r.costCents })),
    });
    return {
      rows,
      totals: {
        registration_number: 'Total',
        depot: plural(found.length, 'compliance'),
        pm_on_time: onTime,
        pm_late: late,
        pm_overdue: overdue,
        pm_compliance_pct: percent(onTime, onTime + late + overdue),
        corrective: sum(found, (r) => r.corrective),
        repeat_repairs: sum(found, (r) => r.repeatRepairs),
        unplanned_failures: failures,
        mtbf_minutes: mtbf(
          [...fleetMinutes.values()].reduce((x, y) => x + y, 0),
          failures,
        ),
        cost_cents: sum(found, (r) => r.costCents),
      },
      sections: [await breakdown('component', 'Repair cost by system', 'System (failed component)'), await breakdown('workshop', 'Repair cost by vendor', 'Workshop')],
    };
  }

  /** FMS-160: incidents and flags per 100,000 km by depot, driver or route, and the appeals against them. */
  private async safety(db: ReadSession, a: Audience, start: Date, end: Date, f: ResolvedFilters, group: SafetyGroup): Promise<{ rows: ReportRow[]; totals: ReportRow }> {
    const found = await this.deps.repo.safety(db, a, start, end, group, f);
    const rows = found.map((r) => ({
      name: r.name,
      distance_m: r.distanceM,
      incidents: r.incidents,
      accidents: r.accidents,
      speeding: r.speeding,
      idling: r.idling,
      incidents_per_100k_km: per100kKm(r.incidents, r.distanceM),
      flags_per_100k_km: per100kKm(r.speeding + r.idling, r.distanceM),
      appeals_opened: r.appealsOpened,
      appeals_approved: r.appealsApproved,
    }));
    const km = sum(found, (r) => r.distanceM);
    const incidents = sum(found, (r) => r.incidents);
    const flags = sum(found, (r) => r.speeding + r.idling);
    return {
      rows,
      totals: {
        name: 'Total',
        distance_m: km,
        incidents,
        accidents: sum(found, (r) => r.accidents),
        speeding: sum(found, (r) => r.speeding),
        idling: sum(found, (r) => r.idling),
        incidents_per_100k_km: per100kKm(incidents, km),
        flags_per_100k_km: per100kKm(flags, km),
        appeals_opened: sum(found, (r) => r.appealsOpened),
        appeals_approved: sum(found, (r) => r.appealsApproved),
      },
    };
  }
}

/** "Addis Ababa Central · 1–31 October 2026 · generated 2026-11-01 14:05 · data as of 14:04 (reporting copy)", Addis Ababa times. */
function subtitle(data: ReportData, freshness: DataFreshness, now: Date): string {
  const lastDay = new Date(new Date(data.period.to).getTime() - 1);
  const through = formatAddisDateTime(lastDay).slice(0, 10);
  return [
    data.depot?.name ?? (data.filter_names.depots.length ? data.filter_names.depots.join(', ') : 'All depots in your scope'),
    `${formatAddisDateTime(data.period.from).slice(0, 10)} to ${through}`,
    `Generated ${formatAddisDateTime(now)} (Addis Ababa)`,
    `Data as of ${formatAddisDateTime(freshness.as_of)}${freshness.source === 'replica' ? ', reporting copy' : ''}`,
  ].join(' · ');
}

/** A score as the ranking reads it: the score, why there is none, and each component's value (punctuality for ties). */
function flatScore(s: DriverScore): { score: number | null; reason: ScoreReason | null; punctuality: number | null; components: Record<ScoreComponent, number | null> } {
  const components = Object.fromEntries(SCORE_COMPONENTS.map((c) => [c, s.components[c].score])) as Record<ScoreComponent, number | null>;
  return { score: s.score, reason: s.reason, punctuality: components.punctuality, components };
}

/** Staff see their depots (FMS-94's audience); a driver, whose own scope is narrower, sees nothing. */
function staffScope(user: RequestUser | undefined): Scope {
  return ownDriverScope(user).kind === 'all' ? depotScope(user) : { kind: 'none' };
}

/** What a report covers, a line each: the period and each filter (an Excel sheet of its own; a PDF's cover). */
function filterLines(data: ReportData): string[] {
  const f = data.filters;
  return [
    `Period: ${data.period.label} (${data.period.first_day} to ${data.period.last_day})`,
    `Depots: ${data.depot?.name ?? (data.filter_names.depots.length ? data.filter_names.depots.join(', ') : 'all in your scope')}`,
    ...(f.vehicle_type ? [`Vehicle type: ${f.vehicle_type}`] : []),
    ...(data.filter_names.vehicle ? [`Vehicle: ${data.filter_names.vehicle}`] : []),
    ...(data.filter_names.driver ? [`Driver: ${data.filter_names.driver}`] : []),
    ...(data.filter_names.route ? [`Route: ${data.filter_names.route}`] : []),
    ...(data.group ? [`Grouped by: ${data.group}`] : []),
  ];
}
