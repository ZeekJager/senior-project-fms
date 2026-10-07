import cors from 'cors';
import express, { type Express } from 'express';
import { pool } from './db';
import { auditLogMiddleware } from './middleware/auditLog';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { requestLogger } from './middleware/requestLogger';
import { modules } from './modules';
import { healthRouter, type ReadinessCheck } from './shared/http/health';

export interface AppOptions {
  /** Dependencies `/health/ready` checks. Defaults to the database. */
  readinessChecks?: Record<string, ReadinessCheck>;
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
  app.use(auditLogMiddleware);

  app.use(healthRouter(readinessChecks));

  for (const mod of modules) {
    if (mod.router) app.use('/api/v1', mod.router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
