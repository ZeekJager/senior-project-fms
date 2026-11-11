import { Router } from 'express';
import { pool, reads } from '../../db';
import { cache } from '../../shared/cache';
import type { JobContext } from '../../shared/jobs/job';
import type { AppModule } from '../../shared/module';
import { settings } from '../settings';
import { analyticsRouter } from './api/analytics.routes';
import { AnalyticsService } from './application/analytics.service';
import { ReportService } from './application/report.service';
import { AnalyticsRepository } from './infrastructure/analytics.repository';
import { ReportRepository } from './infrastructure/report.repository';

// Fleet KPIs (FMS-50): analytics_cache, refreshed hourly (today and yesterday) and nightly (35 days back), read
// through the read replica and kept in Redis per audience and range.
const analyticsService = new AnalyticsService({ db: pool, reads, repo: new AnalyticsRepository(), cache });

// Monthly reports and exports (FMS-91): live from the analytics views on the read replica, as JSON, CSV or PDF. The
// driver score's weights (FMS-146) are settings an administrator tunes.
const reportService = new ReportService({
  reads,
  repo: new ReportRepository(),
  weights: async () => {
    const v = await settings.values();
    return {
      punctuality: v.driver_score_weight_punctuality,
      safety: v.driver_score_weight_safety,
      incidents: v.driver_score_weight_incidents,
      dvir: v.driver_score_weight_dvir,
    };
  },
});

const router = Router();
router.use(analyticsRouter(analyticsService, reportService));

export const analyticsModule: AppModule = {
  name: 'analytics',
  router,
  jobs: [
    { name: 'analytics-refresh-hourly', every: 60, run: (context) => analyticsService.hourly(context) },
    { name: 'analytics-refresh-nightly', at: '02:15', run: (context) => analyticsService.nightly(context) },
  ],
};

/** The refreshes, for tests and the seed: `hourly(context)`, `nightly(context)`, `refresh(context, from, to)`. */
export const analyticsRefresh = {
  hourly: (context: JobContext) => analyticsService.hourly(context),
  nightly: (context: JobContext) => analyticsService.nightly(context),
  refresh: (context: JobContext, from: string, to: string) => analyticsService.refresh(context, from, to),
};
