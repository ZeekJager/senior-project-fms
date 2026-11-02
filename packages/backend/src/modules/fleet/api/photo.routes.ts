import { Router, type Request } from 'express';
import { asyncHandler } from '../../../shared/http/async-handler';
import { receivePhoto, sendPhoto, uploadedPhoto } from '../../../shared/storage/photo';
import { authorize } from '../../auth';
import type { Caller } from '../application/caller';
import type { FleetPhotoService } from '../application/photo.service';
import { driverNotFound } from '../domain/driver';
import { vehicleNotFound } from '../domain/vehicle';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function idParam(req: Request, name: 'vehicleId' | 'driverId'): string {
  const id = req.params[name];
  if (!UUID.test(id)) throw name === 'vehicleId' ? vehicleNotFound() : driverNotFound();
  return id;
}

/** Photos of vehicles (vehicle:read, vehicle:write) and drivers (driver:write), in the caller's depots (docs/photos.md). */
export function photoRouter(service: FleetPhotoService): Router {
  const router = Router();

  router.get(
    '/vehicles/:vehicleId/photo',
    authorize('vehicle:read'),
    asyncHandler(async (req, res) => {
      sendPhoto(res, await service.readVehicle(caller(req), idParam(req, 'vehicleId')));
    }),
  );

  router.put(
    '/vehicles/:vehicleId/photo',
    authorize('vehicle:write'),
    receivePhoto,
    asyncHandler(async (req, res) => {
      res.json({ data: await service.setVehicle(caller(req), idParam(req, 'vehicleId'), uploadedPhoto(res)), meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/vehicles/:vehicleId/photo',
    authorize('vehicle:write'),
    asyncHandler(async (req, res) => {
      await service.removeVehicle(caller(req), idParam(req, 'vehicleId'));
      res.status(204).end();
    }),
  );

  router.put(
    '/drivers/:driverId/photo',
    authorize('driver:write'),
    receivePhoto,
    asyncHandler(async (req, res) => {
      res.json({ data: await service.setDriver(caller(req), idParam(req, 'driverId'), uploadedPhoto(res)), meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/drivers/:driverId/photo',
    authorize('driver:write'),
    asyncHandler(async (req, res) => {
      await service.removeDriver(caller(req), idParam(req, 'driverId'));
      res.status(204).end();
    }),
  );

  return router;
}
