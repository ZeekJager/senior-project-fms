import cors from 'cors';
import express, { type Express } from 'express';
import { auditLogMiddleware } from './middleware/auditLog';
import { requestContext } from './middleware/requestContext';
import { modules } from './modules';

/** Composition root: shared middleware first, then each module's routes. */
export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Correlation id and the audited `dbMutate` helper on every request.
  app.use(requestContext);
  app.use(auditLogMiddleware);

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', service: 'fms-backend', timestamp: new Date() });
  });

  for (const mod of modules) {
    if (mod.router) app.use('/api/v1', mod.router);
  }

  return app;
}
