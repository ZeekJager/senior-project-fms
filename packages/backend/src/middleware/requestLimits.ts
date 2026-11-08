import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors/app-error';

/**
 * The most any request that is not an upload may announce (FMS-103): a request that says it is bigger is refused with 413 before a byte
 * is read or parsed. JSON has its own, much lower, limit (1 MB, app.ts). An upload (multipart) is left to its route, whose limits stop it
 * with the usual 413 once the file passes its size (10 MB for a document, 2 MB for a photo): refusing it here would drop the connection
 * of a person who chose a file that is too big, and their browser would show "failed to fetch" instead of "the file is too large".
 * A body sent chunked has no length to read, so the parsers' limits are what stop it.
 */
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

export function maxRequestBytes(limit: number = MAX_REQUEST_BYTES): RequestHandler {
  return (req, _res, next) => {
    if ((req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data')) return next();
    const announced = Number(req.headers['content-length']);
    if (Number.isFinite(announced) && announced > limit) {
      return next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.'));
    }
    next();
  };
}
