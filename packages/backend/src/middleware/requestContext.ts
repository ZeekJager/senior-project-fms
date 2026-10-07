import type { NextFunction, Request, Response } from 'express';
import { resolveRequestId } from '../shared/http/request-id';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  // One id per request: logs, the error envelope's meta.request_id and the
  // audit log's correlation_id all use it, and the client gets it back.
  req.correlationId = resolveRequestId(req.headers['x-request-id']);
  res.setHeader('X-Request-Id', req.correlationId);

  // Anonymous until `authenticate` (auth module) resolves the access cookie.
  if (!req.user) {
    req.user = { id: null, publicId: null, roles: [], permissions: [], depotId: null };
  }

  next();
}
