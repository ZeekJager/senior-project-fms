import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from '../shared/logging/logger';

function outcome(req: IncomingMessage, res: ServerResponse) {
  return { userId: (req as Request).user?.id ?? null, errorCode: (res as Response).locals?.errorCode };
}

/**
 * One structured line per request: request id, method, path, status,
 * duration (`responseTime`, ms) and user id. 4xx log at warn, 5xx at error
 * with the stack (the error handler sets `res.err`). Health probes are not
 * logged, since load balancers call them every few seconds.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage) => (req as Request).correlationId,
  autoLogging: { ignore: (req: IncomingMessage) => (req.url ?? '').startsWith('/health/') },
  customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Added to the completion line only (customProps would also bind them at
  // request start and repeat the keys).
  customSuccessObject: (req: IncomingMessage, res: ServerResponse, val: object) => ({ ...val, ...outcome(req, res) }),
  customErrorObject: (req: IncomingMessage, res: ServerResponse, _err: Error, val: object) => ({ ...val, ...outcome(req, res) }),
  serializers: {
    req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, path: req.url }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
});
