import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { pool } from './db';
import { auditLogMiddleware } from './middleware/auditLog';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { requestLogger } from './middleware/requestLogger';
import { modules as defaultModules } from './modules';
import { assertEveryRouteDeclaresPolicy } from './shared/authz/route-policy';
import { healthRouter, type ReadinessCheck } from './shared/http/health';
import type { AppModule } from './shared/module';

export interface AppOptions {
  /** Dependencies `/health/ready` checks. Defaults to the database. */
  readinessChecks?: Record<string, ReadinessCheck>;
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
  app.use(express.json({ limit: '1mb' }));
  // Unsigned: session cookies hold a signed JWT or an opaque token whose
  // hash is checked against the database.
  app.use(cookieParser());
  app.use(auditLogMiddleware);

  app.use(healthRouter(readinessChecks));

  for (const mod of options.modules ?? defaultModules) {
    if (mod.router) app.use('/api/v1', mod.router);
  }

  // Deny by default: a route with no declared access policy stops the boot.
  assertEveryRouteDeclaresPolicy(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
