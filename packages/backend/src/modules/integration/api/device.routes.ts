import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { idempotent } from '../../../shared/http/idempotency';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller, DeviceService } from '../application/device.service';
import { deviceNotFound } from '../domain/device';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /integrations/devices. The identifier is the provider's name for the device (an IMEI, a serial): printable, no spaces. */
export const deviceLinkBody = z.strictObject({
  provider_id: z.string().regex(UUID, 'A provider id.'),
  device_identifier: z.string().trim().min(1).max(255).regex(/^[!-~]+$/, 'Letters, digits and punctuation, without spaces.'),
  vehicle_id: z.string().regex(UUID, 'A vehicle id.'),
  device_model: z
    .string()
    .trim()
    .max(255)
    .transform((s) => s || null)
    .nullable()
    .optional(),
  replace: z.boolean().default(false),
});

/** GET /integrations/devices. */
export const deviceListQuery = z.object({
  provider_id: z.string().regex(UUID, 'A provider id.').optional(),
  status: z.enum(['active', 'removed', 'all']).default('all'),
});

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/**
 * The device registry (FMS-138, api-contract §15.1): integration:read lists devices and the unlinked ids providers
 * sent; integration:execute links and unlinks them. Devices are seen through their vehicles' depot scope.
 */
export function deviceRouter(service: DeviceService): Router {
  const router = Router();

  router.get(
    '/integrations/devices',
    authorize('integration:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(deviceListQuery, req.query);
      const data = await service.list(caller(req), { provider: query.provider_id, status: query.status === 'all' ? undefined : query.status });
      res.json({ data, meta: { request_id: req.correlationId, total: data.length } });
    }),
  );

  router.get(
    '/integrations/devices/unknown',
    authorize('integration:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.unknown(), meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/integrations/devices',
    authorize('integration:execute'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const device = await service.link(caller(req), parseInput(deviceLinkBody, req.body));
      res.status(201).json({ data: device, meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/integrations/devices/:deviceId',
    authorize('integration:execute'),
    asyncHandler(async (req, res) => {
      if (!UUID.test(req.params.deviceId)) throw deviceNotFound();
      await service.unlink(caller(req), req.params.deviceId);
      res.status(204).end();
    }),
  );

  return router;
}
