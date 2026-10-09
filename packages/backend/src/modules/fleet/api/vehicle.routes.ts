import { Router, type Request } from 'express';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { pageMeta } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller, VehicleService } from '../application/vehicle.service';
import { vehicleNotFound } from '../domain/vehicle';
import { vehicleCreateBody, vehicleListQuery, vehicleUpdateBody } from './vehicle.schemas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/** The `{vehicle_id}` path parameter. Anything but a UUID cannot name a vehicle: 404. */
function vehicleId(req: Request): string {
  const id = req.params.vehicleId;
  if (!UUID.test(id)) throw vehicleNotFound();
  return id;
}

/** Vehicles (api-contract §6.2): list, register, read, update and retire. */
export function vehicleRouter(service: VehicleService): Router {
  const router = Router();

  router.get(
    '/vehicles',
    authorize('vehicle:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(vehicleListQuery, req.query);
      const { items, total } = await service.list(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/vehicles',
    authorize('vehicle:write'),
    asyncHandler(async (req, res) => {
      const vehicle = await service.create(caller(req), parseInput(vehicleCreateBody, req.body));
      res
        .status(201)
        .location(`/api/v1/vehicles/${vehicle.id}`)
        .set('ETag', etagFor(vehicle.version))
        .json({ data: vehicle, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/vehicles/:vehicleId',
    authorize('vehicle:read'),
    asyncHandler(async (req, res) => {
      const vehicle = await service.get(caller(req), vehicleId(req));
      res.set('ETag', etagFor(vehicle.version)).json({ data: vehicle, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/vehicles/:vehicleId',
    authorize('vehicle:write'),
    asyncHandler(async (req, res) => {
      const id = vehicleId(req);
      const expected = ifMatchVersion(req.get('If-Match'));
      const vehicle = await service.update(caller(req), id, parseInput(vehicleUpdateBody, req.body), expected);
      res.set('ETag', etagFor(vehicle.version)).json({ data: vehicle, meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/vehicles/:vehicleId',
    authorize('vehicle:delete'),
    asyncHandler(async (req, res) => {
      await service.retire(caller(req), vehicleId(req));
      res.status(204).end();
    }),
  );

  return router;
}
