import { Router } from 'express';
import { publicRoute } from '../authz/route-policy';

/** Resolves when the dependency is usable; rejects (or times out) otherwise. */
export type ReadinessCheck = () => Promise<unknown>;

function withTimeout(check: ReadinessCheck, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([check(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * `GET /health/live`: the process is up (no dependencies checked).
 * `GET /health/ready`: every dependency check passes; 503 otherwise, so a
 * load balancer stops sending traffic. Redis and the ML service add their
 * checks in FMS-72 and FMS-75.
 */
export function healthRouter(checks: Record<string, ReadinessCheck>, timeoutMs = 2000): Router {
  const router = Router();

  router.get('/health/live', publicRoute(), (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  router.get('/health/ready', publicRoute(), async (_req, res) => {
    const names = Object.keys(checks);
    const results = await Promise.allSettled(names.map((n) => withTimeout(checks[n], timeoutMs)));
    const report = Object.fromEntries(names.map((n, i) => [n, results[i].status === 'fulfilled' ? 'ok' : 'failed']));
    const ready = results.every((r) => r.status === 'fulfilled');
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'unavailable',
      checks: report,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
