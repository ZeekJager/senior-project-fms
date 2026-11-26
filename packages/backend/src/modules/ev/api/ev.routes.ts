import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { idempotent } from '../../../shared/http/idempotency';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller, EvService } from '../application/ev.service';
import { SESSION_STATUSES, SUMMARY_DAYS_DEFAULT, SUMMARY_DAYS_MAX, WRITABLE_SOURCES, evVehicleMissing, sessionNotFound } from '../domain/ev';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const percent = z.number().min(0).max(100);
const optional = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const batteryLogBody = z.strictObject({
  vehicle_id: z.uuid(),
  state_of_charge: percent,
  battery_health: optional(percent),
  battery_temperature_c: optional(z.number().min(-60).max(150)),
  voltage_v: optional(z.number().min(0).max(2000)),
  current_a: optional(z.number().min(-2000).max(2000)),
  estimated_range_km: optional(z.number().min(0).max(2000)),
  energy_wh_per_km: optional(z.number().min(0).max(10_000)),
  recorded_at: instant.optional(),
  // Synthetic records (FMS-97) say so; provider is the charging webhook's alone.
  source: z.enum(WRITABLE_SOURCES).optional(),
});

const logsQuery = z.strictObject({ ...pageQuery, vehicle_id: z.uuid().optional(), from: instant.optional(), to: instant.optional() });
const stationsQuery = z.strictObject({ ...pageQuery, status: z.string().trim().min(1).max(20).optional() });

const sessionCreate = z.strictObject({
  vehicle_id: z.uuid(),
  station_id: optional(z.uuid()),
  status: z.enum(['planned', 'in_progress']).optional(),
  started_at: instant.optional(),
  start_soc: optional(percent),
  external_session_id: optional(z.string().trim().min(1).max(255)),
  source: z.enum(WRITABLE_SOURCES).optional(),
});

const sessionUpdate = z
  .strictObject({
    status: z.enum(SESSION_STATUSES),
    station_id: z.uuid().nullable(),
    started_at: instant,
    ended_at: instant,
    energy_kwh: z.number().min(0).max(10_000).nullable(),
    // Whole cents: money is never a float (api-contract §3.5).
    cost_cents: z.number().int().min(0).max(100_000_000).nullable(),
    start_soc: percent.nullable(),
    end_soc: percent.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

const sessionsQuery = z.strictObject({ ...pageQuery, status: z.enum(SESSION_STATUSES).optional() });
// The usable capacity when new, kWh (FMS-98): a car's 50 to a bus's 350; whole tenths of a kWh are plenty.
const specBody = z.strictObject({ usable_capacity_kwh: z.number().gt(0).max(2000).multipleOf(0.01) });

const summaryQuery = z.strictObject({ days: z.coerce.number().int().min(1).max(SUMMARY_DAYS_MAX).default(SUMMARY_DAYS_DEFAULT) });

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function id(req: Request, name: string, notFound: () => Error): string {
  const value = req.params[name];
  if (!UUID.test(value)) throw notFound();
  return value;
}

/** EV fleet management (FMS-96, api-contract §13, docs/ev.md): ev:read and ev:write, in the caller's depot scope. */
export function evRouter(service: EvService): Router {
  const router = Router();

  router.get(
    '/ev/battery-logs',
    authorize('ev:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(logsQuery, req.query);
      const { items, total } = await service.batteryLogs(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/ev/battery-logs',
    authorize('ev:write'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const view = await service.logBattery(caller(req), parseInput(batteryLogBody, req.body));
      res.status(201).json({ data: view, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/ev/charging-stations',
    authorize('ev:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(stationsQuery, req.query);
      const { rows, total } = await service.stations(query);
      res.json({ data: rows, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/ev/charging-sessions',
    authorize('ev:write'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const view = await service.createSession(caller(req), parseInput(sessionCreate, req.body));
      res.status(201).json({ data: view, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/ev/charging-sessions/:sessionId',
    authorize('ev:write'),
    asyncHandler(async (req, res) => {
      const view = await service.updateSession(caller(req), id(req, 'sessionId', sessionNotFound), parseInput(sessionUpdate, req.body));
      res.json({ data: view, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/vehicles/:vehicleId/charging-sessions',
    authorize('ev:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(sessionsQuery, req.query);
      const { items, total } = await service.sessionsOf(caller(req), id(req, 'vehicleId', evVehicleMissing), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.put(
    '/vehicles/:vehicleId/battery-spec',
    authorize('ev:write'),
    asyncHandler(async (req, res) => {
      const { usable_capacity_kwh } = parseInput(specBody, req.body);
      const spec = await service.setSpec(caller(req), id(req, 'vehicleId', evVehicleMissing), usable_capacity_kwh);
      res.json({ data: spec, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/vehicles/:vehicleId/battery-summary',
    authorize('ev:read'),
    asyncHandler(async (req, res) => {
      const { days } = parseInput(summaryQuery, req.query);
      const summary = await service.summary(caller(req), id(req, 'vehicleId', evVehicleMissing), days);
      res.json({ data: summary, meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
