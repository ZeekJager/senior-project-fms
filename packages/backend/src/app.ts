import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { pool, reads } from './db';
import { auditLogMiddleware } from './middleware/auditLog';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { requestSource } from './middleware/requestSource';
import { requestLogger } from './middleware/requestLogger';
import { modules as defaultModules } from './modules';
import { integrationGateway, keepsRawBody } from './modules/integration';
import { assertEveryRouteDeclaresPolicy } from './shared/authz/route-policy';
import { cache } from './shared/cache';
import { outboxHealth } from './shared/events/outbox-health';
import { healthRouter, type HealthMetrics, type OptionalDependency, type ReadinessCheck } from './shared/http/health';
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
}

/** Composition root: shared middleware first, then each module's routes. */
export function createApp(options: AppOptions = {}): Express {
  const readinessChecks = options.readinessChecks ?? { database: () => pool.query('SELECT 1') };

  const app = express();
  // Request id first, so every later log line and error carries it.
  app.use(requestContext);
  app.use(requestLogger);
  app.use(cors({ exposedHeaders: ['X-Request-Id'] }));
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
  // After the body parsers: they would drop the async context it sets.
  app.use(requestSource);
  app.use(auditLogMiddleware);

  const outbox = outboxHealth(pool);
  app.use(
    healthRouter(
      readinessChecks,
      undefined,
      // The read replica (FMS-94): degraded when reporting reads fall back to the primary.
      options.optionalDependencies ?? { redis: cache, outbox, replica: reads },
      options.metrics ?? { outbox: async () => ({ ...(await outbox.metrics()) }), integrations: integrationGateway.metrics, replica: () => reads.metrics() },
    ),
  );

  for (const mod of options.modules ?? defaultModules) {
    if (mod.router) app.use('/api/v1', mod.router);
  }

  // Deny by default: a route with no declared access policy stops the boot.
  assertEveryRouteDeclaresPolicy(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
