import { Router } from 'express';
import { pool, reads } from '../../db';
import { cache } from '../../shared/cache';
import type { JobContext } from '../../shared/jobs/job';
import type { AppModule } from '../../shared/module';
import { analyticsRouter } from './api/analytics.routes';
import { AnalyticsService } from './application/analytics.service';
import { AnalyticsRepository } from './infrastructure/analytics.repository';

// Fleet KPIs (FMS-50): analytics_cache, refreshed hourly (today and yesterday) and nightly (35 days back), read
// through the read replica and kept in Redis per audience and range.
const analyticsService = new AnalyticsService({ db: pool, reads, repo: new AnalyticsRepository(), cache });

const router = Router();
router.use(analyticsRouter(analyticsService));

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
