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
  /** Each handler in a route's stack carries its method; `router.route(path).get(...).patch(...)` shares one stack. */
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown; method?: string }[] };
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

/**
 * One method of a route as the app registered it, with the policies it declared, in order. A caller must pass
 * every one: `authorize('prediction:read'), authorize('maintenance:write')` needs both. Empty: none declared.
 */
export interface RegisteredRoute {
  method: string;
  path: string;
  policies: RoutePolicy[];
}

function collect(stack: Layer[], prefix: string, out: RegisteredRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      for (const method of Object.keys(route.methods).filter((m) => route.methods[m])) {
        out.push({
          method: method.toUpperCase(),
          path: `${prefix}${route.path}`,
          policies: route.stack
            .filter((s) => s.method === undefined || s.method === method)
            .map((s) => policyOf(s.handle))
            .filter((p): p is RoutePolicy => p !== undefined),
        });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collect(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
}

/**
 * Every route the app serves, a method at a time in registration order, with its policies: what the startup guard
 * checks, and what the generated access tests (FMS-59) call, so a route is tested the day it is added.
 */
export function routeRegistry(app: Express): RegisteredRoute[] {
  const stack = (app as unknown as { _router?: { stack: Layer[] } })._router?.stack ?? [];
  const routes: RegisteredRoute[] = [];
  collect(stack, '', routes);
  return routes;
}

/** Every route (method and path) that declares no policy. */
export function routesWithoutPolicy(app: Express): string[] {
  return routeRegistry(app)
    .filter((r) => r.policies.length === 0)
    .map((r) => `${r.method} ${r.path}`);
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
