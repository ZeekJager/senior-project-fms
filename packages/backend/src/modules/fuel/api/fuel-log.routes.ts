import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { idempotent } from '../../../shared/http/idempotency';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { FLOAT_IN_MONEY_PATH, parseInput, rejectFractionalMoney } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller, FuelLogService } from '../application/fuel-log.service';
import { FUEL_TYPES, fuelLogNotFound } from '../domain/fuel-log';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A tank holds well under this: 2,000 litres in millilitres. Bigger is a typo (or a unit mix-up). */
const MAX_QUANTITY_ML = 2_000_000;
/** 1,000,000 birr in cents; the column is a 32-bit integer. */
const MAX_COST_CENTS = 100_000_000;
const MAX_ODOMETER_KM = 99_999_999_999.9;

/** Whole units of a fuel or money field: a fraction is VALIDATION_FLOAT_IN_MONEY_PATH (§17), never a rounding. */
const whole = z.number().refine(Number.isInteger, { message: 'Whole units only.', params: { reason: FLOAT_IN_MONEY_PATH } });

const quantityMl = whole.refine((n) => n >= 1 && n <= MAX_QUANTITY_ML, { message: `Between 1 and ${MAX_QUANTITY_ML} ml.`, params: { reason: 'out_of_range' } });
const cents = whole.refine((n) => n >= 0 && n <= MAX_COST_CENTS, { message: `Between 0 and ${MAX_COST_CENTS} cents.`, params: { reason: 'out_of_range' } });

// A physical measurement: one decimal at most, as stored (NUMERIC(12,1)).
const odometer = z
  .number()
  .min(0)
  .max(MAX_ODOMETER_KM)
  .refine((n) => /^\d+(\.\d)?$/.test(String(n)), { message: 'At most one decimal.', params: { reason: 'too_many_decimals' } });

/**
 * POST /fuel-logs (api-contract §9.1). `source` and the time are the server's:
 * a log is recorded when it is received. Anything else is `not_writable`.
 */
const createBody = rejectFractionalMoney(
  z.strictObject({
    vehicle_id: z.uuid(),
    trip_id: z.uuid().optional(),
    driver_id: z.uuid().optional(),
    fuel_type: z.enum(FUEL_TYPES).optional(),
    quantity_ml: quantityMl,
    total_cost_cents: cents,
    unit_price_cents: cents.optional(),
    odometer_km: odometer,
    station_name: z.string().trim().min(1).max(255).optional(),
  }),
);

/** Addis Ababa is UTC+3 all year: a date filter means that local day (as in GET /audit-logs and /trips). */
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
  .object({
    ...pageQuery,
    vehicle_id: z.uuid().optional(),
    driver_id: z.uuid().optional(),
    trip_id: z.uuid().optional(),
    from: instantOrDate.optional(),
    to: instantOrDate.optional(),
    sort_order: z.enum(['asc', 'desc']).default('desc'),
  })
  .transform(({ from, to, ...rest }) => ({ ...rest, from: from ? bound(from, false) : undefined, to: to ? bound(to, true) : undefined }));

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function fuelLogId(req: Request): string {
  const id = req.params.fuelLogId;
  if (!UUID.test(id)) throw fuelLogNotFound();
  return id;
}

/**
 * Fuel logs (api-contract §9.1, FMS-39). Both reads and writes need
 * fuel:read / fuel:write, which drivers hold, so scope does the rest: a
 * driver lists and fetches only their own logs, and another driver's log by
 * id is 404, the same as a missing one. POST takes an optional
 * Idempotency-Key, so a retry from a flaky connection never logs a fill-up twice.
 */
export function fuelLogRouter(service: FuelLogService): Router {
  const router = Router();

  router.get(
    '/fuel-logs',
    authorize('fuel:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total } = await service.list(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/fuel-logs',
    authorize('fuel:write'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const log = await service.create(caller(req), parseInput(createBody, req.body));
      res
        .status(201)
        .location(`/api/v1/fuel-logs/${log.id}`)
        .json({ data: log, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/fuel-logs/:fuelLogId',
    authorize('fuel:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.get(caller(req), fuelLogId(req)), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
