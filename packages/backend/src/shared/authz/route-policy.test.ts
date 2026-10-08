import express, { Router, type RequestHandler } from 'express';
import { describe, expect, it } from 'vitest';
import { assertEveryRouteDeclaresPolicy, policyOf, publicRoute, routesWithoutPolicy, withPolicy } from './route-policy';

const pass: RequestHandler = (_req, _res, next) => next();
const open = () => withPolicy((_req, _res, next) => next(), { kind: 'permission', codes: ['vehicle:read'] });
const handler = (_req: unknown, res: { end(): void }) => res.end();

describe('route policy startup guard', () => {
  it('passes when every route declares a policy', () => {
    const app = express();
    const router = Router();
    router.get('/vehicles', open(), handler);
    router.post('/login', publicRoute(), handler);
    app.use('/api/v1', router);
    app.get('/health', publicRoute(), handler);

    expect(routesWithoutPolicy(app)).toEqual([]);
    expect(() => assertEveryRouteDeclaresPolicy(app)).not.toThrow();
  });

  it('refuses to start when a route declares nothing, naming the method and full path', () => {
    const app = express();
    const router = Router();
    router.get('/vehicles', open(), handler);
    router.delete('/vehicles/:id', handler);
    app.use('/api/v1', router);

    expect(() => assertEveryRouteDeclaresPolicy(app)).toThrow(/DELETE \/api\/v1\/vehicles\/:id/);
    expect(() => assertEveryRouteDeclaresPolicy(app)).not.toThrow(/GET/);
  });

  it('finds an unprotected route on the app itself and in a nested router', () => {
    const app = express();
    const inner = Router();
    inner.get('/deep', handler);
    const outer = Router();
    outer.use('/inner', inner);
    app.use('/api/v1', outer);
    app.get('/loose', handler);

    expect(routesWithoutPolicy(app).sort()).toEqual(['GET /api/v1/inner/deep', 'GET /loose']);
  });

  it('accepts a policy anywhere in the handler chain, including an array of handlers', () => {
    const app = express();
    app.get('/x', [pass, open()], handler);

    expect(routesWithoutPolicy(app)).toEqual([]);
  });

  it('does not count ordinary middleware as a policy', () => {
    const app = express();
    app.get('/x', pass, handler);

    expect(routesWithoutPolicy(app)).toEqual(['GET /x']);
  });

  it('reads the policy back from a tagged handler', () => {
    expect(policyOf(publicRoute())).toEqual({ kind: 'public' });
    expect(policyOf(open())).toEqual({ kind: 'permission', codes: ['vehicle:read'] });
    expect(policyOf(() => undefined)).toBeUndefined();
    expect(policyOf('not a function')).toBeUndefined();
  });
});
