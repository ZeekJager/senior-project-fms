import { config } from '../../config';
import { pool, reads } from '../../db';
import { cache } from '../../shared/cache';
import { logger } from '../../shared/logging/logger';
import type { AppModule } from '../../shared/module';
import { integrationGateway } from '../integration';
import { requestRollup as rollupMiddleware, systemHealthRouter } from './api/system-health.routes';
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
};

const sampler = new HealthSampler({
  db: pool,
  repo,
  probes: standardProbes(sources),
  requests,
  log: logger,
});

export const systemModule: AppModule = {
  name: 'system',
  router: systemHealthRouter(service),
  jobs: [
    {
      // Samples and request counts past 30 days.
      name: 'system-health-retention',
      at: '03:50',
      run: (context) => service.purge(context.now),
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
  /** The server's checks, without the HTTP request to itself, with any source replaced (tests). */
  probes: (overrides: Partial<ProbeSources> = {}) => standardProbes({ ...sources, apiUrl: null, ...overrides }),
  /** The daily retention, for tests. */
  retention: (now: Date) => service.purge(now),
};

export { RequestRecorder, type Probe } from './application/health-sampler';
