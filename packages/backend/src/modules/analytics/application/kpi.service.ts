import { createHash } from 'node:crypto';
import type { Cache } from '../../../shared/cache';
import type { RequestUser } from '../../../types/express';
import { KPIS, change, kpiStatus, type KpiDefinition, type KpiKey, type KpiStatus, type KpiUnit } from '../domain/kpi-targets';
import { monthsBefore, previousPeriod, resolvePeriod, type ReportPeriod } from '../domain/report-period';
import type { ReportData, ReportQuery, ReportService } from './report.service';

export interface KpiServiceDeps {
  reports: Pick<ReportService, 'report'>;
  /** Targets, the amber band and the health score's alert line, from the settings (FMS-157). */
  settings: () => Promise<Record<string, number>>;
  /** Vehicles at risk now, and the period's appeal and feedback counts, as the report filters narrow them. */
  counts: (user: RequestUser | undefined, query: ReportQuery, period: ReportPeriod, healthLine: number) => Promise<{ vehiclesAtRisk: number; appeals: number; feedback: number }>;
  cache: Cache;
  now?: () => Date;
}

export interface KpiView {
  key: KpiKey;
  label: string;
  unit: KpiUnit;
  value: number | null;
  previous: number | null;
  change: number | null;
  target: number | null;
  status: KpiStatus;
  /** The last 12 months, oldest first: [YYYY-MM, value]. */
  sparkline: [string, number | null][];
  /** The report it opens; null for the counts. */
  report: string | null;
}

/** How long a month's figures are kept: a past month an hour, the one under way 5 minutes. */
const PAST_TTL_S = 3600;
const CURRENT_TTL_S = 300;

/**
 * The KPI dashboard (FMS-160, docs/reports.md#kpis): cost per km, fuel L/100 km, utilisation, availability, on time,
 * PM compliance, incidents per 100,000 km, vehicles at risk, and the appeal and feedback counts, for a period and the
 * report filters. Each is read from the totals of the report it opens (so the two agree), with its change from the
 * period before, a 12-month sparkline, and its status against its target. Trends: any KPI over up to 24 months, with
 * last year beside it.
 */
export class KpiService {
  private readonly now: () => Date;

  constructor(private readonly deps: KpiServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** GET /analytics/kpis. */
  async kpis(user: RequestUser | undefined, query: ReportQuery): Promise<{ period: { key: string; label: string; from: string; to: string }; kpis: KpiView[] }> {
    const now = this.now();
    const period = resolvePeriod(query, now);
    const before = previousPeriod(period, now);
    const s = await this.deps.settings();
    const current = await this.values(user, query, period);
    const previous = await this.values(user, query, before);
    const months = monthsBefore(period.end, 12);
    // One month after another: the read session is one connection per request.
    const spark: (readonly [string, Record<KpiKey, number | null>])[] = [];
    for (const m of months) spark.push([m, await this.monthValues(user, query, m)] as const);
    return {
      period: { key: period.key, label: period.label, from: period.from, to: period.to },
      kpis: KPIS.map((def) => {
        const target = def.targetSetting ? (s[def.targetSetting] ?? null) : null;
        return {
          key: def.key,
          label: def.label,
          unit: def.unit,
          value: current[def.key],
          previous: previous[def.key],
          change: change(current[def.key], previous[def.key]),
          target,
          status: kpiStatus(def, current[def.key], target, s.kpi_amber_band_pct ?? 10),
          sparkline: spark.map(([m, v]) => [m, v[def.key]] as [string, number | null]),
          report: def.report,
        };
      }),
    };
  }

  /**
   * GET /analytics/kpis/{kpi}/trend: the KPI month by month over the last `months` (up to 24), with the same month a
   * year before beside each; and, for the period asked, the KPI per depot or per vehicle (the drill-down), from the
   * rows of its report.
   */
  async trend(user: RequestUser | undefined, key: KpiKey, query: ReportQuery & { months?: number; group?: 'depot' | 'vehicle' }) {
    const def = KPIS.find((k) => k.key === key)!;
    const now = this.now();
    const period = resolvePeriod(query, now);
    const count = Math.min(24, Math.max(1, query.months ?? 12));
    const months = monthsBefore(period.end, count + 12);
    const values = new Map<string, number | null>();
    for (const m of months) values.set(m, (await this.monthValues(user, query, m))[key]);
    const series = months.slice(12).map((m, i) => ({ month: m, value: values.get(m) ?? null, last_year: values.get(months[i]) ?? null }));
    let breakdown: { name: string; value: number | null }[] = [];
    if (def.report && def.fromTotals && query.group) {
      const { data } = await this.deps.reports.report(def.report, user, { ...query, ...(def.report === 'safety' && query.group === 'depot' ? { by: 'depot' } : {}) });
      breakdown = groupRows(def, data, query.group);
    }
    return { kpi: key, label: def.label, unit: def.unit, period: { key: period.key, label: period.label }, series, group: query.group ?? null, breakdown };
  }

  /** Every KPI for a period. */
  private async values(user: RequestUser | undefined, query: ReportQuery, period: ReportPeriod): Promise<Record<KpiKey, number | null>> {
    const q: ReportQuery = { ...stripPeriod(query), from: period.from, to: period.to };
    const s = await this.deps.settings();
    const out = {} as Record<KpiKey, number | null>;
    const byReport = new Map<string, ReportData>();
    for (const def of KPIS) {
      if (!def.report || !def.fromTotals) continue;
      if (!byReport.has(def.report)) byReport.set(def.report, (await this.deps.reports.report(def.report, user, q)).data);
      const data = byReport.get(def.report)!;
      out[def.key] = def.fromTotals(data.totals, data.rows);
    }
    const counts = await this.deps.counts(user, q, period, s.health_alert_below ?? 75);
    out.vehicles_at_risk = counts.vehiclesAtRisk;
    out.appeals = counts.appeals;
    out.feedback = counts.feedback;
    return out;
  }

  /** A month's KPIs, cached per caller scope and filters (a past month an hour; this month 5 minutes). */
  private async monthValues(user: RequestUser | undefined, query: ReportQuery, month: string): Promise<Record<KpiKey, number | null>> {
    const now = this.now();
    let period: ReportPeriod;
    try {
      period = resolvePeriod({ month }, now);
    } catch {
      return Object.fromEntries(KPIS.map((k) => [k.key, null])) as Record<KpiKey, number | null>;
    }
    const current = period.end.getTime() >= now.getTime();
    const who = createHash('sha256')
      .update(JSON.stringify({ roles: [...(user?.roles ?? [])].sort(), depot: user?.depotId ?? null, scores: user?.permissions.includes('tracking:read') ?? false, f: stripPeriod(query) }))
      .digest('hex')
      .slice(0, 24);
    return this.deps.cache.getOrSet(this.deps.cache.key('analytics', 'kpi-month', who, month), current ? CURRENT_TTL_S : PAST_TTL_S, () => this.values(user, query, period));
  }
}

/** The filters without the period. */
function stripPeriod(q: ReportQuery): ReportQuery {
  const rest = { ...q } as ReportQuery & { months?: number; group?: string };
  for (const key of ['month', 'quarter', 'year', 'from', 'to', 'months', 'group'] as const) delete rest[key];
  return rest;
}

/** The KPI per depot or per vehicle, from its report's rows (each row's own value, or the depot's sum). */
function groupRows(def: KpiDefinition, data: ReportData, group: 'depot' | 'vehicle'): { name: string; value: number | null }[] {
  const keyOf = (r: Record<string, unknown>) => String((group === 'vehicle' ? r.registration_number : r.depot) ?? r.name ?? '');
  if (group === 'vehicle' || data.report === 'safety') return data.rows.map((r) => ({ name: keyOf(r), value: def.fromTotals!(r, [r]) })).filter((x) => x.name);
  const byDepot = new Map<string, typeof data.rows>();
  for (const r of data.rows) {
    const k = keyOf(r);
    byDepot.set(k, [...(byDepot.get(k) ?? []), r]);
  }
  // A depot's value from its rows as the report totals them: sums of the parts, the ratio of the sums.
  return [...byDepot.entries()].map(([name, rows]) => ({ name, value: def.fromTotals!(depotTotals(def, rows), rows) }));
}

function depotTotals(def: KpiDefinition, rows: readonly Record<string, unknown>[]): Record<string, number | null> {
  const sum = (k: string) => rows.reduce((t, r) => t + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
  switch (def.key) {
    case 'cost_per_km': {
      const m = sum('distance_m');
      return { cost_per_km_cents: m >= 1000 ? Math.round((sum('total_cost_cents') * 1000) / m) : null };
    }
    case 'fuel_l_per_100km': {
      const m = sum('distance_m');
      return { consumption_ml_per_km: m >= 100_000 ? Math.round((sum('fuel_ml') * 1000) / m) : null };
    }
    case 'utilisation_pct': {
      const a = sum('days_available');
      return { utilisation_pct: a > 0 ? Math.round((sum('days_in_use') * 100) / a) : null };
    }
    case 'availability_pct': {
      const fleetMinutes = sum('days_in_fleet') * 1440;
      return { availability_pct: fleetMinutes > 0 ? Math.round(((fleetMinutes - sum('downtime_minutes')) * 100) / fleetMinutes) : null };
    }
    case 'pm_compliance_pct': {
      const all = sum('pm_on_time') + sum('pm_late') + sum('pm_overdue');
      return { pm_compliance_pct: all > 0 ? Math.round((sum('pm_on_time') * 100) / all) : null };
    }
    default:
      return {};
  }
}
