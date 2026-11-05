import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { idempotent } from '../../../shared/http/idempotency';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller, GeofenceService } from '../application/geofence.service';
import { geofenceNotFound } from '../domain/geofence';
import { MAX_POLYGON_POINTS } from '../domain/geometry';
import { GEOFENCE_APPLIES, GEOFENCE_KINDS } from '../domain/location-rules';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (max: number) => z.string().trim().min(1).max(max);

/** [longitude, latitude], as GeoJSON orders them. Ranges are checked with the shape (reason `out_of_range`). */
const position = z.tuple([z.number(), z.number()]);

/** One ring (no holes), open or closed; the service normalizes and checks it. */
const polygon = z.strictObject({
  type: z.literal('Polygon'),
  coordinates: z
    .array(z.array(position).min(3).max(MAX_POLYGON_POINTS + 1))
    .min(1)
    .max(1, { message: 'A geofence is one ring: holes are not supported.' }),
});

const fields = {
  depot_id: z.string().regex(UUID, 'A depot id.'),
  name: text(120),
  description: z
    .string()
    .trim()
    .max(500)
    .transform((s) => s || null)
    .nullable()
    .optional(),
  kind: z.enum(GEOFENCE_KINDS),
  applies: z.enum(GEOFENCE_APPLIES).optional(),
  polygon,
};

/** POST /geofences. */
export const geofenceCreateBody = z.strictObject(fields);

/** PATCH /geofences/{id}: any non-empty subset. */
export const geofenceUpdateBody = z
  .strictObject(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

/** GET /geofences. */
export const geofenceListQuery = z.object({
  depot_id: z.string().regex(UUID, 'A depot id.').optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
});

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/** The `{geofence_id}` path parameter. Anything but a UUID cannot name one: 404. */
function geofenceId(req: Request): string {
  const id = req.params.geofenceId;
  if (!UUID.test(id)) throw geofenceNotFound();
  return id;
}

/**
 * Geofences (api-contract §11.1, FMS-90). tracking:read sees them in its depot scope (the live map draws them);
 * geofence:write (admin) draws, changes, removes and restores them.
 */
export function geofenceRouter(service: GeofenceService): Router {
  const router = Router();

  router.get(
    '/geofences',
    authorize('tracking:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.list(req.user!, parseInput(geofenceListQuery, req.query)), meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/geofences',
    authorize('geofence:write'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const fence = await service.create(caller(req), parseInput(geofenceCreateBody, req.body));
      res
        .status(201)
        .location(`/api/v1/geofences/${fence.geofence_id}`)
        .set('ETag', etagFor(fence.version))
        .json({ data: fence, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/geofences/:geofenceId',
    authorize('tracking:read'),
    asyncHandler(async (req, res) => {
      const fence = await service.get(req.user!, geofenceId(req));
      res.set('ETag', etagFor(fence.version)).json({ data: fence, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/geofences/:geofenceId',
    authorize('geofence:write'),
    asyncHandler(async (req, res) => {
      const id = geofenceId(req);
      const expected = ifMatchVersion(req.get('If-Match'));
      const fence = await service.update(caller(req), id, parseInput(geofenceUpdateBody, req.body), expected);
      res.set('ETag', etagFor(fence.version)).json({ data: fence, meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/geofences/:geofenceId',
    authorize('geofence:write'),
    asyncHandler(async (req, res) => {
      await service.remove(caller(req), geofenceId(req));
      res.status(204).end();
    }),
  );

  router.post(
    '/geofences/:geofenceId/reactivate',
    authorize('geofence:write'),
    asyncHandler(async (req, res) => {
      const fence = await service.reactivate(caller(req), geofenceId(req));
      res.set('ETag', etagFor(fence.version)).json({ data: fence, meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
