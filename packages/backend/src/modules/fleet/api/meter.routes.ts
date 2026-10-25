import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/caller';
import type { MeterService } from '../application/meter.service';
import { METERS } from '../domain/meter';
import { vehicleNotFound } from '../domain/vehicle';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Addis Ababa keeps UTC+3 all year: a bare date is that local day. */
const ADDIS_OFFSET = '+03:00';

/** A `from`/`to` bound: an instant as given, or a date's local start (`from`) or the next day's (`to`, inclusive). */
function bound(value: string, end: boolean): Date {
  if (value.includes('T')) return new Date(value);
  if (!end) return new Date(`${value}T00:00:00${ADDIS_OFFSET}`);
  const next = new Date(`${value}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return new Date(`${next.toISOString().slice(0, 10)}T00:00:00${ADDIS_OFFSET}`);
}

const instantOrDate = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

const meterQuery = z
  .strictObject({
    ...pageQuery,
    meter: z.enum(METERS).optional(),
    from: instantOrDate.optional(),
    to: instantOrDate.optional(),
  })
  .transform(({ from, to, ...rest }) => ({ ...rest, from: from ? bound(from, false) : undefined, to: to ? bound(to, true) : undefined }));

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/** A vehicle's odometer and engine-hour readings (FMS-126): vehicle:read, in the caller's depot scope. */
export function meterRouter(service: MeterService): Router {
  const router = Router();

  router.get(
    '/vehicles/:vehicleId/meter-readings',
    authorize('vehicle:read'),
    asyncHandler(async (req, res) => {
      const id = req.params.vehicleId;
      if (!UUID.test(id)) throw vehicleNotFound();
      const query = parseInput(meterQuery, req.query);
      const { items, total } = await service.list(caller(req), id, query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  return router;
}
