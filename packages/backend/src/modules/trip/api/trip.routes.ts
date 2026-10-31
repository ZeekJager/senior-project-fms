import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { idempotent } from '../../../shared/http/idempotency';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/route.service';
import type { TripService } from '../application/trip.service';
import { COMMAND_STATUSES } from '../domain/lifecycle';
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

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const point = z.strictObject({ latitude, longitude });
const placeName = z.string().trim().min(1).max(120);

/** A trip nobody planned (FMS-139): where it goes; saved as a one-off route. */
const adhocRoute = z.strictObject({
  origin_name: placeName,
  origin: point.nullable().optional(),
  destination_name: placeName,
  destination: point.nullable().optional(),
  stops: z
    .array(
      z
        .strictObject({ name: placeName, latitude: latitude.nullable().optional(), longitude: longitude.nullable().optional() })
        .transform((s) => ({ name: s.name, latitude: s.latitude ?? null, longitude: s.longitude ?? null })),
    )
    .max(25)
    .optional(),
});

/**
 * POST /trips: a route (`route_id`, or a one-off `route` in `depot_id`, FMS-139) and a time window; without an end,
 * the route's estimated time. Ends before or at the start are 400 VALIDATION_INVALID_DATE_RANGE (in the service).
 */
const createBody = z
  .strictObject({
    route_id: z.uuid().optional(),
    route: adhocRoute.optional(),
    depot_id: z.uuid().optional(),
    scheduled_start: instant,
    scheduled_end: instant.optional(),
  })
  .refine((v) => (v.route_id === undefined) !== (v.route === undefined), {
    message: 'Give route_id, or a route for a one-off trip, not both.',
    params: { reason: 'route_id_or_route' },
    path: ['route_id'],
  });

/**
 * PATCH /trips/{id}: reschedule, or cancel. Driver and vehicle come with assignment (FMS-31). Once assigned or en
 * route, a time change needs a `reason`; `shift_following` moves the trips it runs into later (FMS-139).
 */
const updateBody = z
  .strictObject({
    scheduled_start: instant,
    scheduled_end: instant,
    status: z.literal('cancelled'),
    reason: z.string().trim().min(1).max(500),
    shift_following: z.boolean(),
  })
  .partial()
  .refine((v) => v.scheduled_start !== undefined || v.scheduled_end !== undefined || v.status !== undefined, {
    message: 'Send at least one field to change.',
    params: { reason: 'empty_update' },
  });

/** POST /trips/{id}/assign: the version the dispatcher saw is required, so two dispatchers never overwrite each other. */
const assignBody = z.strictObject({
  driver_id: z.uuid(),
  vehicle_id: z.uuid(),
  version: z.number().int().min(0),
});

/** POST /trips/{id}/start and /end take no body (an empty JSON object is fine). */
const noBody = z.strictObject({});

/** POST /trips/{id}/status: the explicit transition (FMS-32). */
const statusBody = z.strictObject({ status: z.enum(COMMAND_STATUSES) });

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
 * (FMS-31; drivers excluded). The lifecycle commands, start, end and status
 * (FMS-32), need trip:execute: a driver moves only their own trips, and
 * scheduling or cancelling through /status also needs trip:write. The POSTs
 * take an optional Idempotency-Key, so a retry never makes a second trip, a
 * second assignment or a second move.
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
      const { trip, shifted } = await service.update(caller(req), id, parseInput(updateBody, req.body), ifMatchVersion(req.get('If-Match')));
      // meta.shifted: the trips moved later to make room (FMS-139), so the console can say which.
      res.set('ETag', etagFor(trip.version)).json({ data: trip, meta: { request_id: req.correlationId, shifted } });
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

  // Lifecycle commands (FMS-32). Optional If-Match: a trip that changed since is 409.
  const command = (path: string, run: (req: Request, id: string, version: number | null) => ReturnType<TripService['start']>) =>
    router.post(
      `/trips/:tripId/${path}`,
      authorize('trip:execute'),
      idempotent(),
      asyncHandler(async (req, res) => {
        const id = tripId(req);
        const { trip, warnings } = await run(req, id, ifMatchVersion(req.get('If-Match')));
        res.set('ETag', etagFor(trip.version)).json({ data: trip, meta: { warnings, request_id: req.correlationId } });
      }),
    );
  command('start', (req, id, version) => {
    parseInput(noBody, req.body ?? {});
    return service.start(caller(req), id, version);
  });
  command('end', (req, id, version) => {
    parseInput(noBody, req.body ?? {});
    return service.end(caller(req), id, version);
  });
  command('status', (req, id, version) => service.changeStatus(caller(req), id, parseInput(statusBody, req.body).status, version));

  return router;
}
