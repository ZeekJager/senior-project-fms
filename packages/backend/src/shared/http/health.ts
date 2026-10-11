import { Router } from 'express';
import { publicRoute } from '../authz/route-policy';
import type { DependencyState } from '../cache/cache';

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
 * A dependency the API can run without (Redis, FMS-72): reported, never a
 * reason for 503. `state` says whether it is configured at all.
 */
export interface OptionalDependency {
  state(): DependencyState;
  ping(): Promise<unknown>;
}

/**
 * `GET /health/live`: the process is up (no dependencies checked).
 * `GET /health/ready`: every required check passes; 503 otherwise, so a
 * load balancer stops sending traffic. Optional dependencies are reported
 * as `ok`, `degraded` (configured but failing: the API serves without it,
 * status `degraded`, still 200) or `disabled` (not configured). The ML
 * service adds its check in FMS-75.
 */
export function healthRouter(checks: Record<string, ReadinessCheck>, timeoutMs = 2000, optional: Record<string, OptionalDependency> = {}): Router {
  const router = Router();

  router.get('/health/live', publicRoute(), (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  router.get('/health/ready', publicRoute(), async (_req, res) => {
    const names = Object.keys(checks);
    const results = await Promise.allSettled(names.map((n) => withTimeout(checks[n], timeoutMs)));
    const report: Record<string, string> = Object.fromEntries(names.map((n, i) => [n, results[i].status === 'fulfilled' ? 'ok' : 'failed']));
    const ready = results.every((r) => r.status === 'fulfilled');

    let degraded = false;
    for (const [name, dep] of Object.entries(optional)) {
      if (dep.state() === 'disabled') {
        report[name] = 'disabled';
        continue;
      }
      // Called on the object: a bare `dep.ping` loses `this`.
      const ok = await withTimeout(() => dep.ping(), timeoutMs).then(
        () => true,
        () => false,
      );
      report[name] = ok ? 'ok' : 'degraded';
      degraded ||= !ok;
    }

    res.status(ready ? 200 : 503).json({
      status: ready ? (degraded ? 'degraded' : 'ok') : 'unavailable',
      checks: report,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
