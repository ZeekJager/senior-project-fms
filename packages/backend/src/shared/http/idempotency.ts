import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { pool } from '../../db';
import { AppError, validationFailed } from '../errors/app-error';
import type { Queryable } from '../infrastructure/queryable';

const DEFAULT_TTL_HOURS = 24;
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/; // printable ASCII, no spaces

/** JSON with object keys sorted, so the same body always hashes the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface StoredKey {
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: unknown;
}

const keyReused = () =>
  new AppError(409, 'CONFLICT_IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
const keyInProgress = () =>
  new AppError(409, 'CONFLICT_IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed.');

/**
 * `Idempotency-Key` support (api-contract §19) for retry-prone POSTs. Put it
 * after `authorize(...)` (it keys on the caller) and before the handler:
 *
 *     router.post('/drivers', authorize('driver:write'), idempotent(), handler);
 *
 * - No header: the request runs as usual.
 * - First use of a key: the request runs; a 2xx response is stored before it
 *   is sent, so a retry can never slip in between. Any other response frees
 *   the key, so a corrected retry may reuse it.
 * - Same key, same request again: the stored response is replayed, with
 *   `Idempotent-Replayed: true`. Nothing runs twice.
 * - Same key, different method, path or body: 409 CONFLICT_IDEMPOTENCY_KEY_REUSED.
 * - Same key while the first request is running: 409 CONFLICT_IDEMPOTENCY_IN_PROGRESS.
 *
 * Keys are per user and kept `ttlHours`. The bookkeeping uses its own
 * connection, outside the handler's transaction (it must survive a rollback).
 */
export function idempotent(options: { ttlHours?: number; db?: Queryable } = {}): RequestHandler {
  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.get('Idempotency-Key');
    if (key === undefined) return next();
    if (!KEY_PATTERN.test(key)) {
      return next(validationFailed([{ field: 'Idempotency-Key', reason: 'invalid_format' }], 'Idempotency-Key must be 1-255 printable characters.'));
    }
    const userId = req.user?.id;
    if (!userId) return next(new Error('idempotent() must run after authentication'));

    const db = options.db ?? pool;
    const path = `${req.baseUrl}${req.path}`;
    const hash = createHash('sha256').update(`${req.method} ${path} ${stableJson(req.body ?? null)}`).digest('hex');

    (async () => {
      // An expired key is forgotten, so it can be used again.
      await db.query('DELETE FROM api.idempotency_keys WHERE user_id = $1 AND idempotency_key = $2 AND expires_at <= now()', [
        userId,
        key,
      ]);
      const claimed = await db.query(
        `INSERT INTO api.idempotency_keys (user_id, idempotency_key, request_method, request_path, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
        [userId, key, req.method, path, hash, ttlHours],
      );

      if (claimed.rowCount === 0) {
        const existing = await db.query<StoredKey>(
          'SELECT request_hash, status, response_status, response_body FROM api.idempotency_keys WHERE user_id = $1 AND idempotency_key = $2',
          [userId, key],
        );
        const stored = existing.rows[0];
        // Still running wins over a body mismatch (api-contract §19).
        if (stored?.status === 'in_progress') throw keyInProgress();
        if (!stored || stored.request_hash !== hash) throw keyReused();
        res.set('Idempotent-Replayed', 'true').status(stored.response_status!).json(stored.response_body);
        return;
      }

      // Record the outcome before the response leaves, then send it.
      const send = res.json.bind(res);
      res.json = (body: unknown) => {
        const done =
          res.statusCode >= 200 && res.statusCode < 300
            ? db.query(
                `UPDATE api.idempotency_keys
                    SET status = 'completed', response_status = $3, response_body = $4, completed_at = now()
                  WHERE user_id = $1 AND idempotency_key = $2`,
                [userId, key, res.statusCode, JSON.stringify(body ?? null)],
              )
            : db.query('DELETE FROM api.idempotency_keys WHERE user_id = $1 AND idempotency_key = $2', [userId, key]);
        done.then(() => send(body), next);
        return res;
      };
      next();
    })().catch(next);
  };
}
