import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { AnalyticsService, Report } from '../application/analytics.service';
import type { KpiService } from '../application/kpi.service';
import type { ReportJobsService } from '../application/report-jobs.service';
import { SCORE_PERMISSION, type ReportService } from '../application/report.service';
import { KPI_KEYS, type KpiKey } from '../domain/kpi-targets';
import { REPORT_FORMATS, REPORT_KINDS, SAFETY_GROUPS, type ReportKind } from '../domain/reports';

/** Addis Ababa days, both included; a depot by public id. */
const analyticsQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  depot_id: z.uuid().optional(),
});

/** A month in Addis Ababa (YYYY-MM), a depot and a vehicle by public id (FMS-131). */
const downtimeQuery = z.object({
  month: z.string().optional(),
  depot_id: z.uuid().optional(),
  vehicle_id: z.uuid().optional(),
});

/** A comma-separated list of public ids (`depot_ids=a,b`), at most 50. */
export const idList = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
  .pipe(z.array(z.uuid()).min(1).max(50));

/**
 * A report (FMS-91, FMS-160): a month (YYYY-MM), a quarter (YYYY-Qn), a year (YYYY) or from and to (days, up to 366);
 * a depot or several, a vehicle type, a vehicle, a driver and a route by public id; safety's grouping; json (default),
 * csv, xlsx or pdf.
 */
export const reportQuery = z.object({
  month: z.string().optional(),
  quarter: z.string().optional(),
  year: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  depot_id: z.uuid().optional(),
  depot_ids: idList.optional(),
  vehicle_type: z.string().trim().min(1).max(40).optional(),
  vehicle_id: z.uuid().optional(),
  driver_id: z.uuid().optional(),
  route_id: z.uuid().optional(),
  by: z.enum(SAFETY_GROUPS).optional(),
  format: z.enum(REPORT_FORMATS).default('json'),
});

/** A KPI's trend (FMS-160): the report filters and period, how many months (up to 24), and the drill-down grouping. */
const trendQuery = reportQuery.extend({
  months: z.coerce.number().int().min(1).max(24).optional(),
  group: z.enum(['depot', 'vehicle']).optional(),
});

/** The driver ranking (FMS-146): a month in Addis Ababa and a depot by public id. */
const rankingQuery = z.object({
  month: z.string().optional(),
  depot_id: z.uuid().optional(),
});

/** A driver's own score (FMS-146): a month in Addis Ababa. */
const ownQuery = z.object({ month: z.string().optional() });

/** A download, as an attachment. Report file names are built of a-z, 0-9, dots and dashes only (ReportService.file). */
const attachment = (filename: string) => `attachment; filename="${filename}"`;

const REPORTS: readonly Report[] = ['fleet-summary', 'utilisation', 'fuel-efficiency', 'maintenance-risk', 'trips', 'alerts'];

/**
 * The analytics API (api-contract §14, FMS-50), `analytics:read`, in the caller's depot scope. Every answer is from
 * analytics_cache and the analytics views on the read replica, and says in `meta` how old the cache is (`computed_at`,
 * `stale` after 25 hours) and which database answered (`data_freshness`).
 */
export function analyticsRouter(service: AnalyticsService, reports: ReportService, kpis?: KpiService, jobs?: ReportJobsService): Router {
  const router = Router();
  // The fleet-wide health score trend (FMS-150): analytics and the health scores themselves (prediction:read).
  router.get(
    '/analytics/health-trend',
    authorize('analytics:read'),
    authorize('prediction:read'),
    asyncHandler(async (req, res) => {
      const { data, meta } = await service.healthTrend(req.user, parseInput(analyticsQuery, req.query));
      res.json({ data, meta: { ...meta, request_id: req.correlationId } });
    }),
  );

  for (const report of REPORTS) {
    router.get(
      `/analytics/${report}`,
      authorize('analytics:read'),
      asyncHandler(async (req, res) => {
        const { data, meta } = await service.report(report, req.user, parseInput(analyticsQuery, req.query));
        res.json({ data, meta: { ...meta, request_id: req.correlationId } });
      }),
    );
  }
  // Availability, MTBF and MTTR for a month (FMS-131): live from the downtime periods, not the cache.
  router.get(
    '/analytics/downtime',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => {
      const { data, meta } = await service.downtime(req.user, parseInput(downtimeQuery, req.query));
      res.json({ data, meta: { ...meta, request_id: req.correlationId } });
    }),
  );

  // The driver ranking (FMS-146, docs/analytics.md): behavioural data, so tracking:read as well as analytics:read.
  router.get(
    '/analytics/driver-ranking',
    authorize('analytics:read'),
    authorize(SCORE_PERMISSION),
    asyncHandler(async (req, res) => {
      const { data, meta } = await reports.driverRanking(req.user, parseInput(rankingQuery, req.query));
      res.json({ data, meta: { ...meta, request_id: req.correlationId } });
    }),
  );

  // A driver's own score (FMS-146): trip:execute, as a driver's own screens; signed in as a driver (404 for staff), never
  // anyone else's, never a rank.
  router.get(
    '/analytics/my-performance',
    authorize('trip:execute'),
    asyncHandler(async (req, res) => {
      const found = await reports.ownPerformance(req.user, parseInput(ownQuery, req.query));
      if (!found) throw notFound('Only a driver has a performance record.');
      res.json({ data: found.data, meta: { ...found.meta, request_id: req.correlationId } });
    }),
  );

  // The KPI dashboard (FMS-160, docs/reports.md#kpis): each KPI, its change, a 12-month sparkline and its status.
  router.get(
    '/analytics/kpis',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => {
      if (!kpis) throw notFound('No KPIs.');
      // A KPI has no file: the format the report query takes is dropped.
      const query: Partial<ReturnType<typeof reportQuery.parse>> = parseInput(reportQuery, req.query);
      delete query.format;
      res.set('Cache-Control', 'no-store').json({ data: await kpis.kpis(req.user, query), meta: { request_id: req.correlationId } });
    }),
  );

  // A KPI's trend over up to 24 months, last year beside it, and its breakdown by depot or vehicle (the drill-down).
  router.get(
    '/analytics/kpis/:kpi/trend',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => {
      if (!kpis) throw notFound('No KPIs.');
      const key = KPI_KEYS.find((k) => k === req.params.kpi) as KpiKey | undefined;
      if (!key) throw notFound('No such KPI.');
      const query: Partial<ReturnType<typeof trendQuery.parse>> = parseInput(trendQuery, req.query);
      delete query.format;
      res.set('Cache-Control', 'no-store').json({ data: await kpis.trend(req.user, key, query), meta: { request_id: req.correlationId } });
    }),
  );

  // Reports and exports (FMS-91, FMS-160, docs/reports.md): the same table as JSON for the screen, CSV, Excel or PDF.
  router.get(
    '/reports/:report',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => {
      const kind = REPORT_KINDS.find((k) => k === req.params.report) as ReportKind | undefined;
      if (!kind) throw notFound('No such report.');
      const { format, ...query } = parseInput(reportQuery, req.query);
      if (format === 'json') {
        const { data, meta } = await reports.report(kind, req.user, query);
        res.json({ data, meta: { ...meta, request_id: req.correlationId } });
        return;
      }
      // Over 20,000 rows the file is made in the background: 202 and the export to poll (FMS-160).
      let file;
      if (jobs) {
        const made = await jobs.exportOrFile({ user: req.user!, correlationId: req.correlationId }, kind, format, query);
        if ('queued' in made) {
          res.status(202).json({ data: made.queued, meta: { request_id: req.correlationId } });
          return;
        }
        file = made.file;
      } else file = await reports.file(kind, format, req.user, query);
      res
        .set({
          'Content-Type': file.contentType,
          'Content-Disposition': attachment(file.filename),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        .send(file.body);
    }),
  );

  return router;
}
