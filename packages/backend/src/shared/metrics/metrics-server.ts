import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { Registry } from 'prom-client';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * The app that serves GET /metrics (FMS-75, docs/metrics.md): nothing else, so a route added to the public API can never
 * be reached through it, and this one is never on the public port. With a token, the scrape must send it as a bearer token;
 * compared in constant time.
 */
export function metricsApp(registry: Registry, token: string | null): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', (req, res, next) => {
    if (token !== null) {
      const sent = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1] ?? '';
      if (!timingSafeEqual(digest(sent), digest(token))) {
        res.status(401).set('WWW-Authenticate', 'Bearer').type('text/plain').send('Unauthorized\n');
        return;
      }
    }
    registry
      .metrics()
      .then((body) => res.set('Content-Type', registry.contentType).set('Cache-Control', 'no-store').send(body))
      .catch(next);
  });
  return app;
}

/** Starts the metrics server; null when `port` is 0 (turned off). */
export function startMetricsServer(registry: Registry, options: { port: number; host: string; token: string | null }, onListening?: (port: number) => void): Server | null {
  if (options.port === 0) return null;
  return metricsApp(registry, options.token).listen(options.port, options.host, () => onListening?.(options.port));
}
