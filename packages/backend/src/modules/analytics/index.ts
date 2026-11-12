import { Router } from 'express';
import { pool, reads } from '../../db';
import { cache } from '../../shared/cache';
import { logger } from '../../shared/logging/logger';
import type { JobContext } from '../../shared/jobs/job';
import type { AppModule } from '../../shared/module';
import { tripRiskModels } from '../maintenance';
import { settings } from '../settings';
import { jobLoad, nightHours } from '../trip';
import { analyticsRouter } from './api/analytics.routes';
import { AnalyticsService } from './application/analytics.service';
import { ReportService } from './application/report.service';
import { TripRiskService } from './application/trip-risk.service';
import { AnalyticsRepository } from './infrastructure/analytics.repository';
import { ReportRepository } from './infrastructure/report.repository';
import { TripRiskRepository } from './infrastructure/trip-risk.repository';

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

// The trip risk model on the dispatch console (FMS-155, docs/ml-trip-risk.md): its inputs from the analytics views on the
// read replica, its chances from the model the ML service serves once an administrator activates it.
const tripRiskService = new TripRiskService({
  reads,
  repo: new TripRiskRepository(),
  models: tripRiskModels,
  jobLoad: (input) => jobLoad(input),
  nightHours,
  log: logger,
});

/**
 * For the dispatch board (fleet, connected by src/modules/index.ts) and `npm run ml:trip-risk-dataset`: the model's
 * status, each available driver's chances on a trip, and the training dataset.
 */
export const tripRisk = {
  forTrip: (tripPublicId: string, driverPublicIds: readonly string[], correlationId: string) => tripRiskService.forTrip(tripPublicId, driverPublicIds, correlationId),
  status: (correlationId: string) => tripRiskService.status(correlationId),
  dataset: () => tripRiskService.dataset(),
  /** Tests: the next board asks the registry again. */
  forget: () => tripRiskService.forget(),
};
export type { DriverTripRisk, TripRiskSummary } from './application/trip-risk.service';
