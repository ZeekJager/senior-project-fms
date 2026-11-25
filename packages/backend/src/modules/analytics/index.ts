import { Router } from 'express';
import type { PoolClient } from 'pg';
import { config } from '../../config';
import { pool, reads } from '../../db';
import { cache } from '../../shared/cache';
import { eventBus } from '../../shared/events/event-bus';
import type { MutationContext } from '../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../shared/infrastructure/queryable';
import { createDocumentStorage } from '../../shared/storage/document-storage';
import { logger } from '../../shared/logging/logger';
import type { JobContext } from '../../shared/jobs/job';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { notificationGateway } from '../integration';
import { tripRiskModels } from '../maintenance';
import { settings } from '../settings';
import { jobLoad, nightHours } from '../trip';
import { isUnplanned, type DowntimeReason } from '../fleet';
import { analyticsRouter } from './api/analytics.routes';
import { reportJobsRouter } from './api/report-jobs.routes';
import { appealRouter } from './api/appeal.routes';
import { feedbackRouter } from './api/feedback.routes';
import { AnalyticsService } from './application/analytics.service';
import { AppealService, type MonthScore } from './application/appeal.service';
import { FeedbackService } from './application/feedback.service';
import { KpiService } from './application/kpi.service';
import { ReportJobsService } from './application/report-jobs.service';
import { ReportService } from './application/report.service';
import { KPI_SETTING_KEYS } from './domain/kpi-targets';
import { TripRiskService } from './application/trip-risk.service';
import { monthEnd, monthStart } from './domain/appeal';
import { scoreDriver, type ScoreWeights } from './domain/driver-score';
import { AnalyticsRepository } from './infrastructure/analytics.repository';
import { AppealRepository } from './infrastructure/appeal.repository';
import { AttachmentUrlSigner } from './infrastructure/attachment-url';
import { FeedbackRepository } from './infrastructure/feedback.repository';
import { ReportRepository } from './infrastructure/report.repository';
import { ReportStoreRepository } from './infrastructure/report-store.repository';
import { writePdf, writeXlsx } from './infrastructure/report-writers';
import { TripRiskRepository } from './infrastructure/trip-risk.repository';

// Fleet KPIs (FMS-50): analytics_cache, refreshed hourly (today and yesterday) and nightly (35 days back), read
// through the read replica and kept in Redis per audience and range.
const analyticsService = new AnalyticsService({ db: pool, reads, repo: new AnalyticsRepository(), cache });

// Monthly reports and exports (FMS-91): live from the analytics views on the read replica, as JSON, CSV or PDF. The
// driver score's weights (FMS-146) are settings an administrator tunes.
const reportRepository = new ReportRepository();
const scoreWeights = async (): Promise<ScoreWeights> => {
  const v = await settings.values();
  return {
    punctuality: v.driver_score_weight_punctuality,
    safety: v.driver_score_weight_safety,
    incidents: v.driver_score_weight_incidents,
    dvir: v.driver_score_weight_dvir,
  };
};

/** A driver's month and its score, on this connection (inside a decision's transaction it sees the new exclusion). */
async function monthScore(db: Queryable, driverUserId: string, month: string): Promise<MonthScore> {
  const [row] = await reportRepository.drivers(db, { scope: { kind: 'all' } }, monthStart(month), monthEnd(month), driverUserId);
  const m = row ?? { tripsCompleted: 0, distanceM: 0, tripsTimed: 0, tripsOnTime: 0, speeding: 0, idling: 0, accidents: 0, tripsInspected: 0 };
  const figures = {
    trips_completed: m.tripsCompleted,
    distance_m: m.distanceM,
    trips_timed: m.tripsTimed,
    trips_on_time: m.tripsOnTime,
    speeding: m.speeding,
    idling: m.idling,
    accidents: m.accidents,
    trips_inspected: m.tripsInspected,
  };
  return { score: scoreDriver(m, await scoreWeights()), figures };
}

// Admin-to-driver feedback (FMS-158, docs/driver-feedback.md): on the primary; categories and retention are settings.
const feedbackService = new FeedbackService({
  repo: new FeedbackRepository(pool),
  events: eventBus,
  rules: async () => ({
    categories: (await settings.get<string[]>('feedback_categories')) ?? [],
    retentionMonths: (await settings.get<number>('feedback_retention_months')) ?? 24,
  }),
  score: monthScore,
  users: userDirectory,
});

// Score appeals (FMS-159, docs/score-appeals.md): on the primary, the files in the document storage under appeals/.
const appealService = new AppealService({
  repo: new AppealRepository(pool),
  storage: createDocumentStorage(config.storage),
  urls: new AttachmentUrlSigner(config.jwtSecret),
  events: eventBus,
  rules: async () => {
    const v = await settings.values();
    return { windowDays: v.appeal_window_days, reviewWorkingDays: v.appeal_review_working_days };
  },
  score: monthScore,
  users: userDirectory,
  feedback: {
    ownLiveItem: (db, driverId, publicId) => feedbackService.ownLiveItem(db, driverId, publicId),
    authorOf: (db, feedbackId) => feedbackService.authorOf(db, feedbackId),
  },
});

const analyticsRepository = new AnalyticsRepository();
const reportService = new ReportService({
  reads,
  repo: reportRepository,
  weights: scoreWeights,
  // Utilisation and downtime (FMS-160) from the downtime periods and service spans (FMS-131).
  downtime: {
    serviceSpans: (db, ids) => analyticsRepository.serviceSpans(db, ids),
    downtimeFacts: (db, ids, from, to) => analyticsRepository.downtimeFacts(db, ids, from, to),
    isUnplanned: (reason) => isUnplanned(reason as DowntimeReason),
  },
  writers: { xlsx: writeXlsx, pdf: writePdf },
  corrections: (db, userId, month) => appealService.corrections(db, userId, month),
});

// The KPI dashboard and trends (FMS-160): read from the reports' totals, targets from the settings.
const kpiService = new KpiService({
  reports: reportService,
  settings: async () => {
    const v = await settings.values();
    const out: Record<string, number> = { health_alert_below: v.health_alert_below };
    for (const key of KPI_SETTING_KEYS) {
      const value = await settings.get<number>(key);
      if (typeof value === 'number') out[key] = value;
    }
    return out;
  },
  counts: (user, query, _period, line) => reportService.counts(user, query, line),
  cache,
});

// Saved filters, background exports and schedules (FMS-160): on the primary; files under reports/exports/ in the document
// storage, behind links signed for their own purpose.
const reportJobs = new ReportJobsService({
  repo: new ReportStoreRepository(pool),
  reports: reportService,
  storage: createDocumentStorage(config.storage),
  urls: new AttachmentUrlSigner(config.jwtSecret, Date.now, 'fms:report-file-url:v1', '/api/v1/report-files/{id}/content'),
  users: userDirectory,
  mailer: { send: (message, correlationId) => notificationGateway.send(message, correlationId) },
  appUrl: config.app.publicUrl,
});

const router = Router();
// Before GET /reports/{report}, which would match /reports/filters and /reports/schedules.
router.use(reportJobsRouter(reportJobs));
router.use(analyticsRouter(analyticsService, reportService, kpiService, reportJobs));
router.use(appealRouter(appealService));
router.use(feedbackRouter(feedbackService));

export const analyticsModule: AppModule = {
  name: 'analytics',
  router,
  jobs: [
    { name: 'analytics-refresh-hourly', every: 60, run: (context) => analyticsService.hourly(context) },
    { name: 'analytics-refresh-nightly', at: '02:15', run: (context) => analyticsService.nightly(context) },
    // An appeal undecided past its review deadline goes to its depot admin, once (FMS-159).
    { name: 'appeal-escalation', every: 15, run: ({ now, correlationId }) => appealService.escalate({ now, correlationId }) },
    // A decision the driver never acknowledged closes a week after it was made.
    { name: 'appeal-auto-close', at: '03:50', run: ({ now, correlationId }) => appealService.autoClose({ now, correlationId }) },
    // Feedback older than feedback_retention_months (24) is deleted, retracted items too (FMS-158).
    { name: 'feedback-retention', at: '03:40', run: ({ now, correlationId }) => feedbackService.purge({ now, correlationId }) },
    // Report schedules due now, and failed recipients' retries (FMS-160).
    { name: 'report-schedules', every: 5, run: ({ now, correlationId }) => reportJobs.runSchedules({ now, correlationId }) },
    // Exports over 20,000 rows, made in the background; files past their 24 hours removed.
    { name: 'report-exports', every: 1, run: ({ now, correlationId }) => reportJobs.runExports({ now, correlationId }) },
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

/** For tests: the appeal jobs as of `now`. */
export const appealJobs = {
  escalate: (now: Date, correlationId: string) => appealService.escalate({ now, correlationId }),
  autoClose: (now: Date, correlationId: string) => appealService.autoClose({ now, correlationId }),
};
export { APPEAL_EVENTS } from './domain/appeal';

/**
 * A driver's feedback (FMS-158) for the privacy module (FMS-104): their data export, and an erasure, on the caller's
 * transaction. Internal driver ids.
 */
export const driverFeedbackData = {
  forDriver: (db: Queryable, driverId: string) => feedbackService.exportFor(db, driverId),
  erase: (client: PoolClient, ctx: MutationContext, driverId: string) => feedbackService.eraseFor(client, ctx, driverId),
};

/** For tests: the report jobs as of `now` (FMS-160). */
export const reportJobsRun = {
  schedules: (now: Date, correlationId: string, maxAttachmentBytes?: number) => reportJobs.runSchedules({ now, correlationId, maxAttachmentBytes }),
  exports: (now: Date, correlationId: string) => reportJobs.runExports({ now, correlationId }),
};

/** For tests: the feedback retention job as of `now`. */
export const feedbackJobs = {
  purge: (now: Date, correlationId: string) => feedbackService.purge({ now, correlationId }),
};
export { FEEDBACK_EVENTS } from './domain/feedback';

/** The reports' PDF table writer (FMS-91), for the capacity report (FMS-163). */
export { renderTablePdf, type PdfTable } from './infrastructure/table-pdf';
