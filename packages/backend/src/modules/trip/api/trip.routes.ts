import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { idempotent } from '../../../shared/http/idempotency';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/route.service';
import type { TripService } from '../application/trip.service';
import { TRIP_STATUSES, tripNotFound } from '../domain/trip';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 100;

/** Addis Ababa is UTC+3 all year: a date filter means that local day (as in GET /audit-logs). */
const ADDIS_OFFSET = '+03:00';

/** A date `to` covers that whole day: the bound is the next local midnight. */
function bound(value: string, end: boolean): Date {
  if (value.includes('T')) return new Date(value);
  if (!end) return new Date(`${value}T00:00:00${ADDIS_OFFSET}`);
  const next = new Date(`${value}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return new Date(`${next.toISOString().slice(0, 10)}T00:00:00${ADDIS_OFFSET}`);
}

const instantOrDate = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

/** POST /trips: a route and a time window. Ends before or at the start are 400 VALIDATION_INVALID_DATE_RANGE (in the service). */
const createBody = z.strictObject({
  route_id: z.uuid(),
  scheduled_start: instant,
  scheduled_end: instant,
});

/** PATCH /trips/{id}: reschedule, or cancel. Driver and vehicle come with assignment (FMS-31). */
const updateBody = z
  .strictObject({ scheduled_start: instant, scheduled_end: instant, status: z.literal('cancelled') })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

/** POST /trips/{id}/assign: the version the dispatcher saw is required, so two dispatchers never overwrite each other. */
const assignBody = z.strictObject({
  driver_id: z.uuid(),
  vehicle_id: z.uuid(),
  version: z.number().int().min(0),
});

const historyQuery = z
  .object({
    /** One status or several, comma-separated: status=scheduled,assigned. */
    status: z
      .string()
      .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
      .pipe(z.array(z.enum(TRIP_STATUSES)).min(1))
      .optional(),
    driver_id: z.uuid().optional(),
    vehicle_id: z.uuid().optional(),
    route_id: z.uuid().optional(),
    depot_id: z.uuid().optional(),
    from: instantOrDate.optional(),
    to: instantOrDate.optional(),
    sort_order: z.enum(['asc', 'desc']).default('desc'),
    page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    cursor: z.string().min(1).max(200).optional(),
  })
  .transform(({ from, to, ...rest }) => ({ ...rest, from: from ? bound(from, false) : undefined, to: to ? bound(to, true) : undefined }));

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function tripId(req: Request): string {
  const id = req.params.tripId;
  if (!UUID.test(id)) throw tripNotFound();
  return id;
}

/**
 * Trips and trip history (api-contract §7.2, FMS-30). Reads need trip:read;
 * staff see their depots' trips and a driver only their own. Writes need
 * trip:write (admin, fleet manager, dispatcher); assignment trip:assign
 * (FMS-31; drivers excluded). The POSTs take an optional Idempotency-Key, so
 * a retry never makes a second trip or a second assignment.
 */
export function tripRouter(service: TripService): Router {
  const router = Router();

  router.get(
    '/trips',
    authorize('trip:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(historyQuery, req.query);
      const { items, nextCursor } = await service.history(caller(req), query);
      res.json({ data: items, meta: { page_size: query.page_size, next_cursor: nextCursor, request_id: req.correlationId } });
    }),
  );

  router.post(
    '/trips',
    authorize('trip:write'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const trip = await service.create(caller(req), parseInput(createBody, req.body));
      res
        .status(201)
        .location(`/api/v1/trips/${trip.id}`)
        .set('ETag', etagFor(trip.version))
        .json({ data: trip, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/trips/:tripId',
    authorize('trip:read'),
    asyncHandler(async (req, res) => {
      const trip = await service.get(caller(req), tripId(req));
      res.set('ETag', etagFor(trip.version)).json({ data: trip, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/trips/:tripId',
    authorize('trip:write'),
    asyncHandler(async (req, res) => {
      const id = tripId(req);
      const trip = await service.update(caller(req), id, parseInput(updateBody, req.body), ifMatchVersion(req.get('If-Match')));
      res.set('ETag', etagFor(trip.version)).json({ data: trip, meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/trips/:tripId/assign',
    authorize('trip:assign'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const id = tripId(req);
      const { trip, warnings } = await service.assign(caller(req), id, parseInput(assignBody, req.body));
      res.set('ETag', etagFor(trip.version)).json({ data: trip, meta: { warnings, request_id: req.correlationId } });
    }),
  );

  return router;
}
