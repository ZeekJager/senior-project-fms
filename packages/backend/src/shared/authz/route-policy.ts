import type { Express, RequestHandler } from 'express';

/**
 * What a route declares about who may call it (deny by default: a route that
 * declares nothing stops the app from starting).
 *
 * - `public`: anyone, including anonymous callers (login, health checks).
 * - `authenticated`: any signed-in user, no particular permission (`/auth/me`).
 * - `permission`: a signed-in user holding at least one of the codes.
 */
export type RoutePolicy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; codes: readonly string[] };

const POLICY = Symbol('fms.routePolicy');

type Marked = RequestHandler & { [POLICY]?: RoutePolicy };

/** Tags a handler so the startup check can see which policy a route declared. */
export function withPolicy<H extends RequestHandler>(handler: H, policy: RoutePolicy): H {
  (handler as Marked)[POLICY] = policy;
  return handler;
}

export function policyOf(handler: unknown): RoutePolicy | undefined {
  return typeof handler === 'function' ? (handler as Marked)[POLICY] : undefined;
}

/** Declares a route open to everyone. Use it on purpose: it is the only way to skip authentication. */
export function publicRoute(): RequestHandler {
  return withPolicy((_req, _res, next) => next(), { kind: 'public' });
}

interface Layer {
  name?: string;
  regexp?: RegExp;
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle?: { stack?: Layer[] };
}

/** `/api/v1` out of the regexp Express 4 builds for `app.use('/api/v1', router)`. */
function mountPath(layer: Layer): string {
  const source = layer.regexp?.source ?? '';
  return source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/')
    .replace(/^\/?$/, '');
}

function collect(stack: Layer[], prefix: string, out: { route: string; ok: boolean }[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route!.methods[m])
        .map((m) => m.toUpperCase())
        .join(',');
      out.push({
        route: `${methods} ${prefix}${layer.route.path}`,
        ok: layer.route.stack.some((s) => policyOf(s.handle) !== undefined),
      });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collect(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
}

/** Every route (method and path) that declares no policy. */
export function routesWithoutPolicy(app: Express): string[] {
  const stack = (app as unknown as { _router?: { stack: Layer[] } })._router?.stack ?? [];
  const routes: { route: string; ok: boolean }[] = [];
  collect(stack, '', routes);
  return routes.filter((r) => !r.ok).map((r) => r.route);
}

/**
 * Startup guard. Throws, so the process never starts serving, when any route
 * lacks `authorize(...)`, `authenticated()` or `publicRoute()`. A forgotten
 * permission check is then a failed boot in development and CI, not a hole in
 * production.
 */
export function assertEveryRouteDeclaresPolicy(app: Express): void {
  const missing = routesWithoutPolicy(app);
  if (missing.length > 0) {
    throw new Error(
      `Routes without an access policy (add authorize('resource:action'), authenticated() or publicRoute()):\n${missing
        .map((r) => `  - ${r}`)
        .join('\n')}`,
    );
  }
}
