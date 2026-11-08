import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { AppError } from '../errors/app-error';

/**
 * Rate limits (FMS-103, api-contract §20, docs/security.md): how many requests a client may make in a minute, by what kind of client it
 * is, so a flood from one cannot take the API from the others.
 *
 * | Client | Counted by | Policy |
 * |---|---|---|
 * | Signed-in browser | its session (a hash of the access cookie) | `session` |
 * | The same, uploading | its session | `upload` (as well) |
 * | A GPS device | its bearer token | `device` |
 * | A provider's webhook | the provider | `webhook` |
 * | Nobody signed in | the address | `anonymous` |
 * | The sign-in, refresh and password calls | the address | `auth` (as well) |
 * | Anyone | the address | `ip_ceiling`, high: a backstop for fake cookies, shared offices (NAT) pass it easily |
 *
 * Fixed one-minute windows, in Redis (shared by every instance) with this process's memory as the fallback when Redis is down or not
 * configured: the limit then holds per instance, which is looser but never open. Counting fails open: a store error lets the request
 * through (and is logged), because a broken counter must not take the API down.
 */
export interface RateLimits {
  /** Requests a minute, per kind of client (see the table). */
  session: number;
  upload: number;
  device: number;
  webhook: number;
  anonymous: number;
  auth: number;
  ipCeiling: number;
}

export const WINDOW_MS = 60_000;

export interface RateHit {
  /** Requests counted in the window, this one included. */
  count: number;
  /** Milliseconds until the window ends. */
  ttlMs: number;
}

export interface RateStore {
  hit(key: string, windowMs: number): Promise<RateHit>;
}

/** Counts in this process. A window starts at a key's first request. */
export class MemoryRateStore implements RateStore {
  private readonly windows = new Map<string, { count: number; expires: number }>();
  private lastSweep = 0;
  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, windowMs: number): Promise<RateHit> {
    const now = this.now();
    this.sweep(now);
    let w = this.windows.get(key);
    if (!w || w.expires <= now) {
      w = { count: 0, expires: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { count: w.count, ttlMs: w.expires - now };
  }

  /** Forgets finished windows, at most once a window, so the map is bounded by one window's distinct keys. */
  private sweep(now: number): void {
    if (now - this.lastSweep < WINDOW_MS) return;
    this.lastSweep = now;
    for (const [key, w] of this.windows) if (w.expires <= now) this.windows.delete(key);
  }
}

/** Counts in Redis: INCR, and the window set on the key's first hit (NX, so later hits do not extend it). */
export class RedisRateStore implements RateStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: (key: string) => string,
  ) {}

  async hit(key: string, windowMs: number): Promise<RateHit> {
    const k = this.prefix(key);
    const results = await this.redis.multi().incr(k).pexpire(k, windowMs, 'NX').pttl(k).exec();
    if (!results) throw new Error('Redis rate limit transaction was discarded');
    const [incr, , ttl] = results;
    if (incr[0] || ttl[0]) throw incr[0] ?? ttl[0];
    return { count: Number(incr[1]), ttlMs: Math.max(0, Number(ttl[1])) };
  }
}

/** Redis while it answers, this process's memory when it does not (reported once per failure). */
export class FallbackRateStore implements RateStore {
  constructor(
    private readonly primary: RateStore | null,
    private readonly fallback: RateStore,
    private readonly onFallback: (err: unknown) => void = () => undefined,
  ) {}

  async hit(key: string, windowMs: number): Promise<RateHit> {
    if (this.primary) {
      try {
        return await this.primary.hit(key, windowMs);
      } catch (err) {
        this.onFallback(err);
      }
    }
    return this.fallback.hit(key, windowMs);
  }
}

interface Rule {
  policy: keyof RateLimits | 'ip_ceiling';
  key: string;
  limit: number;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const ACCESS_COOKIE_PATTERN = /(?:^|;\s*)fms_access=([^;]+)/;
const AUTH_PATHS = new Set(['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/logout', '/api/v1/auth/password']);

/** The limits that apply to a request, from what kind of client sent it. Reads headers only: it runs before the body is parsed. */
export function rulesFor(req: Pick<Request, 'path' | 'ip' | 'headers' | 'get'>, limits: RateLimits): Rule[] {
  const ip = req.ip ?? 'unknown';
  const rules: Rule[] = [{ policy: 'ip_ceiling', key: `ip:${ip}`, limit: limits.ipCeiling }];
  if (AUTH_PATHS.has(req.path)) rules.push({ policy: 'auth', key: `auth:${ip}`, limit: limits.auth });

  const webhook = /^\/api\/v1\/webhooks\/([^/]+)\/([^/]+)/.exec(req.path);
  if (webhook) {
    rules.push({ policy: 'webhook', key: `webhook:${webhook[1]}:${webhook[2]}`, limit: limits.webhook });
    return rules;
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
  if (bearer) {
    rules.push({ policy: 'device', key: `device:${digest(bearer)}`, limit: limits.device });
    return rules;
  }
  const cookie = ACCESS_COOKIE_PATTERN.exec(req.headers.cookie ?? '')?.[1];
  if (cookie) {
    const session = digest(cookie);
    rules.push({ policy: 'session', key: `session:${session}`, limit: limits.session });
    if ((req.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
      rules.push({ policy: 'upload', key: `upload:${session}`, limit: limits.upload });
    }
    return rules;
  }
  rules.push({ policy: 'anonymous', key: `anonymous:${ip}`, limit: limits.anonymous });
  return rules;
}

export interface RateLimiterOptions {
  store: RateStore;
  limits: RateLimits;
  onError?: (err: unknown) => void;
  /** Left alone: probes would drown the counters and say nothing about clients. */
  skip?: (req: Request) => boolean;
}

/**
 * 429 RATE_LIMITED with `Retry-After` when a limit is passed; otherwise the headers say how much is left of the tightest one
 * (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset: seconds, as in the IETF draft).
 */
export function rateLimiter(options: RateLimiterOptions): RequestHandler {
  const skip = options.skip ?? ((req: Request) => req.path.startsWith('/health/'));
  return (req, res, next) => {
    if (skip(req)) return next();
    const rules = rulesFor(req, options.limits);
    Promise.all(rules.map((rule) => options.store.hit(rule.key, WINDOW_MS)))
      .then((hits) => {
        let tightest = { remaining: Infinity, limit: 0, resetSeconds: 0 };
        for (const [i, hit] of hits.entries()) {
          const { limit } = rules[i];
          const resetSeconds = Math.max(1, Math.ceil(hit.ttlMs / 1000));
          if (hit.count > limit) {
            return next(
              new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.', [{ reason: rules[i].policy }], {
                'Retry-After': String(resetSeconds),
                'RateLimit-Limit': String(limit),
                'RateLimit-Remaining': '0',
                'RateLimit-Reset': String(resetSeconds),
              }),
            );
          }
          if (limit - hit.count < tightest.remaining) tightest = { remaining: limit - hit.count, limit, resetSeconds };
        }
        res.setHeader('RateLimit-Limit', String(tightest.limit));
        res.setHeader('RateLimit-Remaining', String(tightest.remaining));
        res.setHeader('RateLimit-Reset', String(tightest.resetSeconds));
        next();
      })
      .catch((err: unknown) => {
        options.onError?.(err);
        next();
      });
  };
}
