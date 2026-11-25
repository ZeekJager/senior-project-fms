import { Router } from 'express';
import { config } from '../../config';
import { pool, reads } from '../../db';
import { cache } from '../../shared/cache';
import { logger } from '../../shared/logging/logger';
import type { AppModule } from '../../shared/module';
import { pitrService } from '../backup';
import { integrationGateway } from '../integration';
import { requestRollup as rollupMiddleware, systemHealthRouter } from './api/system-health.routes';
import { webVitalsRouter } from './api/web-vitals.routes';
import { monitoringRouter } from './api/monitoring.routes';
import { MonitoringService } from './application/monitoring.service';
import { MaintenanceRepository } from './infrastructure/maintenance.repository';
import { prometheusClient } from './infrastructure/prometheus.client';
import { setMetricReaders } from '../../shared/metrics/domain-metrics';
import { eventBus } from '../../shared/events/event-bus';
import { renderTablePdf } from '../analytics';
import { settings } from '../settings';
import { tripLookups } from '../trip';
import { HealthSampler, RequestRecorder, type Probe } from './application/health-sampler';
import { SystemHealthService } from './application/system-health.service';
import { HealthRepository } from './infrastructure/health.repository';
import { standardProbes, type ProbeSources } from './infrastructure/probes';

// System health (FMS-143, docs/system-health.md): a sample of every component each minute, the API's
// requests per minute, and GET /system/health for the admin's screen (S-31).

const repo = new HealthRepository();
const requests = new RequestRecorder();
const service = new SystemHealthService({ db: pool, repo });

/** The checks as the server runs them: its own /health/live, the primary, the replica, Redis, the AI service and the providers. */
const sources: ProbeSources = {
  database: pool,
  replica: reads,
  redis: cache,
  apiUrl: `http://127.0.0.1:${config.port}/health/live`,
  aiServiceUrl: config.ml.service?.url ?? null,
  circuits: () => integrationGateway.circuits(),
  backups: () => pitrService.findings(),
};

const sampler = new HealthSampler({
  db: pool,
  repo,
  probes: standardProbes(sources),
  requests,
  log: logger,
});

// Monitoring (FMS-109, FMS-163, docs/observability.md): resources from Prometheus for the Resources tab, Alertmanager's
// webhook into the alert engine, maintenance windows and the capacity report. The thresholds are settings.
const monitoring = new MonitoringService({
  prometheus: config.observability.prometheusUrl ? prometheusClient(config.observability.prometheusUrl) : null,
  repo: new MaintenanceRepository(pool),
  events: eventBus,
  thresholds: async () => {
    const v = await settings.values();
    return {
      cpu: [v.monitor_cpu_warning_pct, v.monitor_cpu_critical_pct],
      memory: [v.monitor_memory_warning_pct, v.monitor_memory_critical_pct],
      disk: [v.monitor_disk_warning_pct, v.monitor_disk_critical_pct],
      dbConnections: [v.monitor_db_connections_warning_pct, v.monitor_db_connections_critical_pct],
      replicaLag: [v.monitor_replica_lag_warning_seconds, v.monitor_replica_lag_critical_seconds],
      errorRate: [v.monitor_error_rate_warning_pct, v.monitor_error_rate_critical_pct],
      p95: [v.monitor_p95_warning_ms, v.monitor_p95_critical_ms],
      gpsSilenceMinutes: v.monitor_gps_silence_minutes,
    };
  },
  pdf: (table) => renderTablePdf(table),
});

// What Prometheus' alert rules compare against (fms_alert_threshold), the backups' findings and the trips under way.
setMetricReaders({
  thresholds: async () => {
    const v = await settings.values();
    return Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith('monitor_')));
  },
  backups: async () => {
    const { findings } = await pitrService.findings();
    const counts: Record<string, number> = { critical: 0, warning: 0 };
    for (const f of findings) counts[f.severity === 'critical' ? 'critical' : 'warning'] += 1;
    return counts;
  },
  tripsUnderWay: () => tripLookups.underWay(pool),
});

// Web vitals reported by the web app (FMS-75, docs/metrics.md) sit beside the health screen's routes.
const router = Router();
router.use(systemHealthRouter(service));
router.use(webVitalsRouter());
router.use(monitoringRouter(monitoring, config.observability.alertmanagerToken));

export const systemModule: AppModule = {
  name: 'system',
  router,
  jobs: [
    {
      // Samples and request counts past 30 days.
      name: 'system-health-retention',
      at: '03:50',
      run: (context) => service.purge(context.now),
    },
    {
      // A maintenance window's start and end, written to the audit log when they happen (FMS-163).
      name: 'maintenance-window-edges',
      every: 1,
      run: ({ now, correlationId }) => monitoring.recordWindowEdges({ now, correlationId }),
    },
  ],
};

/** Counts each request for the rollups (src/app.ts mounts it first). */
export const requestRollup = rollupMiddleware(requests);

export const systemHealth = {
  /** Starts sampling every minute on this instance (src/server.ts; never tests or scripts). */
  start: (): void => sampler.start(),
  stop: (): Promise<void> => sampler.stop(),
  /** The request counts the middleware has made and not yet written. */
  requests,
  /** For tests: a sampler with these checks, writing like the server's, with its own request counts (the middleware's by default). */
  samplerWith: (probes: () => Promise<Probe[]>, counts: RequestRecorder = requests): HealthSampler => new HealthSampler({ db: pool, repo, probes, requests: counts }),
  /**
   * The server's checks, without the HTTP request to itself, with any source replaced (tests). Backups is disabled
   * unless given: its queries would run beside the database check's on a test's single connection.
   */
  probes: (overrides: Partial<ProbeSources> = {}) =>
    standardProbes({ ...sources, apiUrl: null, backups: async () => ({ enabled: false, findings: [] }), ...overrides }),
  /** The daily retention, for tests. */
  retention: (now: Date) => service.purge(now),
};

export { RequestRecorder, type Probe } from './application/health-sampler';

/** For tests: the monitoring service's job and webhook as the server runs them. */
export const monitoringJobs = {
  recordWindowEdges: (now: Date, correlationId: string) => monitoring.recordWindowEdges({ now, correlationId }),
};
