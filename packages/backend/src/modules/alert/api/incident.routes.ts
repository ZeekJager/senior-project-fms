import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { idempotent, OFFLINE_QUEUE_TTL_HOURS } from '../../../shared/http/idempotency';
import { pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller, IncidentService } from '../application/incident.service';
import { SEVERITIES } from '../domain/alert';
import { INCIDENT_STATUSES, INCIDENT_TYPES, incidentNotFound } from '../domain/incident';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

/**
 * POST /incidents (api-contract §12.2). `description` and `severity` are required; `incident_type`
 * defaults to `other` and `occurred_at` to now. The status and the reporter are the server's: anything
 * else is `not_writable`. A location is both coordinates or neither.
 */
const createBody = z
  .strictObject({
    description: z.string().trim().min(1).max(2000),
    severity: z.enum(SEVERITIES),
    incident_type: z.enum(INCIDENT_TYPES).optional(),
    vehicle_id: z.uuid().optional(),
    trip_id: z.uuid().optional(),
    driver_id: z.uuid().optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    occurred_at: instant.optional(),
  })
  .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), {
    message: 'Send both latitude and longitude, or neither.',
    path: ['longitude'],
    params: { reason: 'location_incomplete' },
  });

/** One value or several, comma-separated: severity=high,critical. */
const list = z.string().transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean));

/** Addis Ababa is UTC+3 all year: a date filter means that local day (as in GET /fuel-logs and /trips). */
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

const listQuery = z
  .strictObject({
    ...pageQuery,
    status: list.pipe(z.array(z.enum(INCIDENT_STATUSES)).min(1)).optional(),
    severity: list.pipe(z.array(z.enum(SEVERITIES)).min(1)).optional(),
    incident_type: list.pipe(z.array(z.enum(INCIDENT_TYPES)).min(1)).optional(),
    vehicle_id: z.uuid().optional(),
    from: instantOrDate.optional(),
    to: instantOrDate.optional(),
  })
  .transform(({ from, to, ...rest }) => ({ ...rest, from: from ? bound(from, false) : undefined, to: to ? bound(to, true) : undefined }));

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function incidentId(req: Request): string {
  const id = req.params.incidentId;
  if (!UUID.test(id)) throw incidentNotFound();
  return id;
}

/**
 * Incidents (api-contract §12.2, FMS-38). incident:write reports (drivers, technicians, depot admins,
 * fleet managers, admins); incident:read reads, newest first. A driver sees only what they reported;
 * staff, their depots' incidents. POST takes an optional Idempotency-Key, so the offline queue's retries
 * record an incident once; a replay after the key expired, with the same `occurred_at` and description,
 * answers `200` with the original and `created: false`.
 */
export function incidentRouter(service: IncidentService): Router {
  const router = Router();

  router.post(
    '/incidents',
    authorize('incident:write'),
    idempotent({ ttlHours: OFFLINE_QUEUE_TTL_HOURS }),
    asyncHandler(async (req, res) => {
      const { incident, created } = await service.create(caller(req), parseInput(createBody, req.body));
      res
        .status(created ? 201 : 200)
        .location(`/api/v1/incidents/${incident.id}`)
        .json({ data: incident, meta: { created, request_id: req.correlationId } });
    }),
  );

  router.get(
    '/incidents',
    authorize('incident:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, meta } = await service.list(caller(req), query);
      res.json({ data: items, meta: { ...meta, request_id: req.correlationId } });
    }),
  );

  router.get(
    '/incidents/:incidentId',
    authorize('incident:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.get(caller(req), incidentId(req)), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
