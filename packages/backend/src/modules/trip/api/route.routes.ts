import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller, RouteService } from '../application/route.service';
import { routeNotFound } from '../domain/route';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At most `places` decimals, as the column stores them (a longer value would be rounded and then look changed). */
const decimals = (places: number) => (n: number) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;

const latitude = z.number().min(-90).max(90).refine(decimals(6), { message: 'At most 6 decimals.', params: { reason: 'too_many_decimals' } });
const longitude = z.number().min(-180).max(180).refine(decimals(6), { message: 'At most 6 decimals.', params: { reason: 'too_many_decimals' } });

const coordinates = z.strictObject({ latitude, longitude });

const placeName = z.string().trim().max(255).transform((s) => s || null).nullable().optional();

/** A stop: a name, and a map point when one is known (both parts or neither). */
const stop = z
  .strictObject({ name: z.string().trim().min(1).max(255), latitude: latitude.nullable().optional(), longitude: longitude.nullable().optional() })
  .refine((s) => (s.latitude == null) === (s.longitude == null), { message: 'Give both latitude and longitude, or neither.', params: { reason: 'incomplete_coordinates' } })
  .transform((s) => ({ name: s.name, latitude: s.latitude ?? null, longitude: s.longitude ?? null }));

const fields = {
  name: z.string().trim().min(1).max(255),
  depot_id: z.uuid(),
  origin_name: placeName,
  origin: coordinates.nullable().optional(),
  destination_name: placeName,
  destination: coordinates.nullable().optional(),
  stops: z.array(stop).max(25).optional(),
  /** Entered by hand until the mapping adapter (FMS-84) measures it. */
  distance_km: z.number().min(0).max(100_000).refine(decimals(3), { message: 'At most 3 decimals.', params: { reason: 'too_many_decimals' } }).nullable().optional(),
  estimated_duration_seconds: z.number().int().min(0).max(30 * 24 * 3600).nullable().optional(),
};

/** POST /routes. depot_id is required: a route without a depot is 400. */
const createBody = z.strictObject(fields);

/** PATCH /routes/{id}: the fields sent; is_active false retires the route. */
const updateBody = z
  .strictObject({ ...fields, is_active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

const listQuery = z.object({
  ...pageQuery,
  depot_id: z.uuid().optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((s) => s || undefined),
  status: z.enum(['active', 'retired', 'all']).default('active'),
  sort_by: z.enum(['name', 'distance_km', 'updated_at']).default('name'),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
});

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function routeId(req: Request): string {
  const id = req.params.routeId;
  if (!UUID.test(id)) throw routeNotFound();
  return id;
}

/**
 * Routes (api-contract §7.1, FMS-83). Reads need route:read, writes
 * route:write (admin, fleet manager, dispatcher, depot admin). Depot scope
 * applies to both: a depot's dispatcher never sees another depot's routes.
 */
export function routeRouter(service: RouteService): Router {
  const router = Router();

  router.get(
    '/routes',
    authorize('route:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total } = await service.list(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/routes',
    authorize('route:write'),
    asyncHandler(async (req, res) => {
      const route = await service.create(caller(req), parseInput(createBody, req.body));
      res
        .status(201)
        .location(`/api/v1/routes/${route.id}`)
        .set('ETag', etagFor(route.version))
        .json({ data: route, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/routes/:routeId',
    authorize('route:read'),
    asyncHandler(async (req, res) => {
      const route = await service.get(caller(req), routeId(req));
      res.set('ETag', etagFor(route.version)).json({ data: route, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/routes/:routeId',
    authorize('route:write'),
    asyncHandler(async (req, res) => {
      const id = routeId(req);
      const route = await service.update(caller(req), id, parseInput(updateBody, req.body), ifMatchVersion(req.get('If-Match')));
      res.set('ETag', etagFor(route.version)).json({ data: route, meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
