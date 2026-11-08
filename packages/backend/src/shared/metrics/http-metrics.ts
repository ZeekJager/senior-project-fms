import type { NextFunction, Request, Response } from 'express';
import { httpRequestDuration } from './registry';

/** Probes and the metrics endpoint would drown the traffic and say nothing about users. */
const NOT_COUNTED = /^\/health\//;

const API_PREFIX = '/api/v1';

/**
 * The route a request matched, as its template (`/api/v1/vehicles/:vehicleId/tracking`), never the URL: ids in a label would make
 * a series per vehicle. A request no route matched (a 404, a scan) is one `unmatched` series, so a bot cannot grow the label set.
 * Express resets `baseUrl` once an error leaves a router, so the prefix is taken from the URL when it is gone: every module
 * route is mounted under /api/v1.
 */
export function routeTemplate(req: Pick<Request, 'baseUrl' | 'route' | 'originalUrl'>): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string') return 'unmatched';
  const base = req.baseUrl || (req.originalUrl.startsWith(`${API_PREFIX}/`) ? API_PREFIX : '');
  return `${base}${path}`;
}

/** Observes every API request's duration when its response is sent (FMS-75). No paths with ids, bodies, users or query strings. */
export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  if (NOT_COUNTED.test(req.path)) return next();
  const started = process.hrtime.bigint();
  res.once('finish', () => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    httpRequestDuration.observe({ method: req.method, route: routeTemplate(req), status_class: `${Math.floor(res.statusCode / 100)}xx` }, seconds);
  });
  next();
}
