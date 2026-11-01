import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { AnalyticsService, Report } from '../application/analytics.service';
import type { ReportService } from '../application/report.service';
import { REPORT_FORMATS, REPORT_KINDS, type ReportKind } from '../domain/reports';

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

/** A monthly report (FMS-91): a month in Addis Ababa, a depot by public id, and json (default), csv or pdf. */
const reportQuery = z.object({
  month: z.string().optional(),
  depot_id: z.uuid().optional(),
  format: z.enum(REPORT_FORMATS).default('json'),
});

/** A download, as an attachment. Report file names are built of a-z, 0-9, dots and dashes only (ReportService.file). */
const attachment = (filename: string) => `attachment; filename="${filename}"`;

const REPORTS: readonly Report[] = ['fleet-summary', 'utilisation', 'fuel-efficiency', 'maintenance-risk', 'trips', 'alerts'];

/**
 * The analytics API (api-contract §14, FMS-50), `analytics:read`, in the caller's depot scope. Every answer is from
 * analytics_cache and the analytics views on the read replica, and says in `meta` how old the cache is (`computed_at`,
 * `stale` after 25 hours) and which database answered (`data_freshness`).
 */
export function analyticsRouter(service: AnalyticsService, reports: ReportService): Router {
  const router = Router();
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

  // Monthly reports and exports (FMS-91, docs/reports.md): the same table as JSON for the screen, CSV or PDF.
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
      const file = await reports.file(kind, format, req.user, query);
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
