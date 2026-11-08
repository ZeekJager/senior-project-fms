import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { config } from './config';
import { pool, reads } from './db';
import { auditLogMiddleware } from './middleware/auditLog';
import { corsPolicy } from './middleware/cors';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { requestSource } from './middleware/requestSource';
import { requestLogger } from './middleware/requestLogger';
import { maxRequestBytes } from './middleware/requestLimits';
import { API_DOCS_CSP, securityHeaders } from './middleware/securityHeaders';
import { modules as defaultModules } from './modules';
import { integrationGateway, keepsRawBody } from './modules/integration';
import { ACCESS_COOKIE, auditCsrfDenied, REFRESH_COOKIE } from './modules/auth';
import { requestRollup } from './modules/system';
import { assertEveryRouteDeclaresPolicy } from './shared/authz/route-policy';
import { cache, redis, redisKey } from './shared/cache';
import { outboxHealth } from './shared/events/outbox-health';
import { apiDocs, apiDocsEnabledFor } from './shared/http/api-docs';
import { csrfProtection, CsrfTokens } from './shared/http/csrf';
import { FallbackRateStore, MemoryRateStore, rateLimiter, RedisRateStore, type RateLimits, type RateStore } from './shared/http/rate-limit';
import { logger } from './shared/logging/logger';
import { healthRouter, type HealthMetrics, type OptionalDependency, type ReadinessCheck } from './shared/http/health';
import { mlReadiness } from './shared/http/ml-readiness';
import { setMetricReaders } from './shared/metrics/domain-metrics';
import { httpMetrics } from './shared/metrics/http-metrics';
import type { AppModule } from './shared/module';

export interface AppOptions {
  /** Dependencies `/health/ready` checks. Defaults to the database. */
  readinessChecks?: Record<string, ReadinessCheck>;
  /** Reported by /health/ready but never a reason for 503. Defaults to Redis (the app's cache) and the event outbox. */
  optionalDependencies?: Record<string, OptionalDependency>;
  /** Numbers /health/ready reports. Defaults to the event outbox's lag and the integration circuits. */
  metrics?: Record<string, HealthMetrics>;
  /** The modules to mount. Defaults to every module; tests pass their own routes. */
  modules?: AppModule[];
  /** Serve the API documentation page at /api-docs (FMS-65). Defaults to on, except in production. */
  apiDocs?: boolean;
  /** The AI service in /health/ready (FMS-75). Defaults to ML_SERVICE_URL and READINESS_ML_CRITICAL. */
  ml?: { url: string | null; critical: boolean };
  /**
   * Whether cookie-authenticated writes must send the CSRF token (FMS-103). On, except under NODE_ENV=test, where hundreds of tests
   * make cookie-authenticated calls without the header: the CSRF tests turn it on. The Origin check is always on. There is no
   * setting that turns it off in a deployment.
   */
  csrfToken?: boolean;
  /**
   * Rate limits (FMS-103). On, with the configured limits and Redis (memory when it is down), except under NODE_ENV=test, where the
   * whole suite is one address making thousands of requests: the rate limit tests turn it on with their own store and limits.
   */
  rateLimit?: { store?: RateStore; limits?: RateLimits };
}

/** Routes whose callers cannot send the CSRF header (shared/http/csrf.ts): the session is being made or ended, or it is a beacon. */
const CSRF_TOKEN_EXEMPT = new Set(['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/logout', '/api/v1/auth/password', '/api/v1/telemetry/web-vitals']);

/** Composition root: shared middleware first, then each module's routes. */
export function createApp(options: AppOptions = {}): Express {
  // The AI service (FMS-75): a reason for 503 only when the deployment says it cannot run without it; degraded otherwise.
  const ml = options.ml ?? { url: config.ml.service?.url ?? null, critical: config.readiness.mlCritical };
  const mlProbe = mlReadiness({ url: ml.url });
  const readinessChecks = {
    ...(options.readinessChecks ?? { database: () => pool.query('SELECT 1') }),
    ...(ml.url && ml.critical ? { ml: () => mlProbe.ping() } : {}),
  };

  const app = express();
  // Behind nginx or a load balancer: believe X-Forwarded-For that many hops, so the address of a request is the client's (FMS-103).
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
  // Request id first, so every later log line and error carries it.
  app.use(requestContext);
  // The API's response headers (FMS-103): no script, frame or sniffing in anything it answers.
  app.use(securityHeaders({ production: config.nodeEnv === 'production' }));
  app.use(requestLogger);
  // Per-minute request and 5xx counts and latencies for the system health screen (FMS-143): counts only.
  app.use(requestRollup);
  // Per-route latency histograms for /metrics (FMS-75): the route template, never the URL.
  app.use(httpMetrics);
  // CORS (FMS-103, middleware/cors.ts): only the origins CORS_ALLOWED_ORIGINS names; the CSRF check below refuses a write from any other.
  const allowedOrigins = config.cors.allowedOrigins;
  app.use(corsPolicy(allowedOrigins));
  // A request that announces more than any upload can be is refused before it is read (FMS-103).
  app.use(maxRequestBytes());
  // Rate limits by kind of client (FMS-103, shared/http/rate-limit.ts), before the body is parsed or anything is looked up.
  if (options.rateLimit || config.nodeEnv !== 'test') {
    let warned = false;
    const store =
      options.rateLimit?.store ??
      new FallbackRateStore(redis ? new RedisRateStore(redis, (key) => redisKey('throttle', 'rl', key)) : null, new MemoryRateStore(), (err) => {
        if (!warned) logger.warn({ err }, 'rate limits: Redis failed; counting in this process');
        warned = true;
      });
    app.use(rateLimiter({ store, limits: options.rateLimit?.limits ?? config.rateLimits, onError: (err) => logger.warn({ err }, 'rate limits: the counter failed; the request is let through') }));
  }
  app.use(
    express.json({
      limit: '1mb',
      // A webhook's signature covers its exact bytes, which parsing loses (FMS-85).
      verify: (req, _res, buf) => {
        if (keepsRawBody(req as express.Request)) (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  // Unsigned: session cookies hold a signed JWT or an opaque token whose
  // hash is checked against the database.
  app.use(cookieParser());
  // CSRF (FMS-103, shared/http/csrf.ts): a write that carries the session cookies must come from this site and send the token.
  const csrfTokens = new CsrfTokens(config.jwtSecret);
  app.use(
    csrfProtection({
      tokens: csrfTokens,
      allowedOrigins,
      accessCookie: ACCESS_COOKIE,
      refreshCookie: REFRESH_COOKIE,
      requireToken: options.csrfToken ?? config.nodeEnv !== 'test',
      exemptFromToken: (req) => CSRF_TOKEN_EXEMPT.has(req.path),
      onDenied: (req, reason) => {
        logger.warn({ method: req.method, path: req.path, reason, origin: req.get('origin') ?? null }, 'a cookie-authenticated write was refused as cross-site');
        return auditCsrfDenied(req, reason);
      },
    }),
  );
  // After the body parsers: they would drop the async context it sets.
  app.use(requestSource);
  app.use(auditLogMiddleware);

  const outbox = outboxHealth(pool);
  // What /metrics reads at a scrape (FMS-75): the same signals as /health/ready, as numbers.
  setMetricReaders({ outbox: () => outbox.metrics(), replica: () => reads.metrics(), circuits: () => integrationGateway.circuits() });
  app.use(
    healthRouter(
      readinessChecks,
      undefined,
      // The read replica (FMS-94): degraded when reporting reads fall back to the primary.
      options.optionalDependencies ?? { redis: cache, outbox, replica: reads, ...(ml.url && ml.critical ? {} : { ml: mlProbe }) },
      options.metrics ?? { outbox: async () => ({ ...(await outbox.metrics()) }), integrations: integrationGateway.metrics, replica: () => reads.metrics() },
    ),
  );

  if (options.apiDocs ?? apiDocsEnabledFor(config.nodeEnv)) {
    const docs = apiDocs();
    if (docs) {
      // Its own policy: the page loads Swagger UI's scripts and styles from this origin (the API's is `default-src 'none'`).
      app.use('/api-docs', (_req, res, next) => (res.setHeader('Content-Security-Policy', API_DOCS_CSP), next()), docs);
    }
  }

  for (const mod of options.modules ?? defaultModules) {
    if (mod.router) app.use('/api/v1', mod.router);
  }

  // Deny by default: a route with no declared access policy stops the boot.
  assertEveryRouteDeclaresPolicy(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
