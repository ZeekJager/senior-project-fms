import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { withRequestSource } from '../infrastructure/request-source';

/**
 * Express 4 does not catch rejected promises; this forwards them to the
 * error handler. It also runs the handler in the request's source context
 * (middleware/requestSource.ts), so its audit rows record the channel, IP
 * and user agent even when a streaming parser lost the async context.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    const run = () => fn(req, res, next).catch(next);
    if (req.requestSource) withRequestSource(req.requestSource, run);
    else void run();
  };
}
