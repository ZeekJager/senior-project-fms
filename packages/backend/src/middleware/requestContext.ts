import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  // Every request gets a correlation id for the audit log.
  req.correlationId = randomUUID();

  // FMS-05 populates req.user from the JWT; until then the actor is anonymous.
  if (!req.user) {
    req.user = { id: null };
  }

  next();
}
