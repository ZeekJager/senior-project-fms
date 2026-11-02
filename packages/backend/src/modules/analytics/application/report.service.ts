import { depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import type { DataFreshness, ReadSession } from '../../../shared/infrastructure/read-router';
import type { RequestUser } from '../../../types/express';
import { monthWindow } from '../domain/downtime';
import {
  centsPerKm,
  formatAddisDateTime,
  formatValue,
  FUEL_TYPE_WORDS,
  isNumeric,
  mlPerKmDriven,
  monthTitle,
  percent,
  REPORTS,
  toCsv,
  tripStatusWord,
  type ReportColumn,
  type ReportFormat,
  type ReportKind,
  type ReportRow,
} from '../domain/reports';
import type { Audience } from '../infrastructure/analytics.repository';
import type { ReportRepository } from '../infrastructure/report.repository';
import { renderTablePdf } from '../infrastructure/table-pdf';

export interface ReportQuery {
  /** YYYY-MM in Addis Ababa; this month when left out. */
  month?: string;
  depot_id?: string;
}

/** A report as GET /reports/{report} returns it (format json), and what the CSV and PDF are written from. */
export interface ReportData {
  report: ReportKind;
  title: string;
  month: string;
  /** The month as instants, [from, to): up to now for the current month. */
  period: { from: string; to: string };
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
  now?: () => Date;
}

const FILE_NAMES: Record<ReportKind, string> = {
  fuel: 'fuel-report',
  maintenance: 'maintenance-report',
  cost: 'cost-report',
  trips: 'trip-history',
  drivers: 'driver-performance',
};

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

  async report(kind: ReportKind, user: RequestUser | undefined, query: ReportQuery): Promise<{ data: ReportData; meta: { data_freshness: DataFreshness } }> {
    const w = monthWindow(query.month, this.now());
    const db = await this.deps.reads.session();
    const { repo } = this.deps;
    const a: Audience = { scope: staffScope(user) };
    let depot: ReportData['depot'] = null;
    if (query.depot_id) {
      const found = await repo.depot(db, query.depot_id, a);
      // A depot that is unknown, or not one of the caller's, matches nothing: an empty report, as a filter does elsewhere.
      if (found) {
        a.depotId = found.id;
        depot = { id: query.depot_id, name: found.name, code: found.code };
      } else a.scope = { kind: 'none' };
    }

    const { rows, totals } = await this.build(kind, db, a, w.start, w.end);
    return {
      data: {
        report: kind,
        title: REPORTS[kind].title,
        month: w.month,
        period: { from: w.start.toISOString(), to: w.end.toISOString() },
        depot,
        columns: REPORTS[kind].columns,
        rows,
        totals: rows.length > 0 ? totals : null,
        generated_at: this.now().toISOString(),
      },
      meta: { data_freshness: db.freshness() },
    };
  }

  /** The report as a file to download: CSV, or PDF. */
  async file(kind: ReportKind, format: Exclude<ReportFormat, 'json'>, user: RequestUser | undefined, query: ReportQuery): Promise<ReportFile> {
    const { data, meta } = await this.report(kind, user, query);
    const filename = `${FILE_NAMES[kind]}-${data.month}-${(data.depot?.code ?? 'all').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'depot'}.${format}`;
    if (format === 'csv') return { filename, contentType: 'text/csv; charset=utf-8', body: toCsv(data.columns, data.rows, data.totals) };
    const cells = (row: ReportRow) => data.columns.map((c) => formatValue(c.kind, row[c.key] ?? null, { grouped: true }));
    return {
      filename,
      contentType: 'application/pdf',
      body: renderTablePdf({
        title: `${data.title}, ${monthTitle(data.month)}`,
        subtitle: subtitle(data, meta.data_freshness, this.now()),
        columns: data.columns.map((c) => ({ label: c.label, align: isNumeric(c.kind) ? 'right' : 'left' })),
        rows: data.rows.map(cells),
        totals: data.totals ? cells(data.totals) : null,
        footer: `${data.title}, ${monthTitle(data.month)} · ${plural(data.rows.length, kind)}`,
      }),
    };
  }

  private async build(kind: ReportKind, db: ReadSession, a: Audience, start: Date, end: Date): Promise<{ rows: ReportRow[]; totals: ReportRow }> {
    const { repo } = this.deps;
    switch (kind) {
      case 'fuel': {
        const found = await repo.fuel(db, a, start, end);
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
        const found = await repo.maintenance(db, a, start, end);
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
        const found = await repo.cost(db, a, start, end);
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
        const found = await repo.trips(db, a, start, end);
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
        const found = await repo.drivers(db, a, start, end);
        return {
          rows: found.map((r) => ({
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
}

/** "Addis Ababa Central · 1–31 October 2026 · generated 2026-11-01 14:05 · data as of 14:04 (reporting copy)", Addis Ababa times. */
function subtitle(data: ReportData, freshness: DataFreshness, now: Date): string {
  const lastDay = new Date(new Date(data.period.to).getTime() - 1);
  const through = formatAddisDateTime(lastDay).slice(0, 10);
  return [
    data.depot?.name ?? 'All depots in your scope',
    `${formatAddisDateTime(data.period.from).slice(0, 10)} to ${through}`,
    `Generated ${formatAddisDateTime(now)} (Addis Ababa)`,
    `Data as of ${formatAddisDateTime(freshness.as_of)}${freshness.source === 'replica' ? ', reporting copy' : ''}`,
  ].join(' · ');
}

/** Staff see their depots (FMS-94's audience); a driver, whose own scope is narrower, sees nothing. */
function staffScope(user: RequestUser | undefined): Scope {
  return ownDriverScope(user).kind === 'all' ? depotScope(user) : { kind: 'none' };
}
