import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { AppError } from '../shared/errors/app-error';
import { errorBody, toAppError } from '../shared/errors/to-app-error';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}.`));
}

/**
 * Last middleware: every error leaves as the contract envelope
 * (api-contract §3.4) with an error code from §3.6. Internal details never
 * reach the client; the stack is included only in development.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const appErr = toAppError(err);
  res.locals.errorCode = appErr.code;
  if (appErr.status >= 500) {
    // Picked up by the request logger, which logs it with the stack.
    res.err = err instanceof Error ? err : new Error(String(err));
  }
  if (appErr.headers) res.set(appErr.headers);
  const stack = config.nodeEnv === 'development' && appErr.status >= 500 && err instanceof Error ? err.stack : undefined;
  res.status(appErr.status).json(errorBody(appErr, req.correlationId, stack));
}
