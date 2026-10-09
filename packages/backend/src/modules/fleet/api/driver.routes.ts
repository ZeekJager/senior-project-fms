import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { validationFailed } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { idempotent } from '../../../shared/http/idempotency';
import { pageMeta } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authenticated, authorize } from '../../auth';
import type { Caller } from '../application/caller';
import type { DriverService } from '../application/driver.service';
import { driverNotFound } from '../domain/driver';
import { parseDriverImport } from './driver-import';
import { driverCreateBody, driverListQuery, driverUpdateBody } from './driver.schemas';

/** The CSV body of POST /drivers/import (the app parses JSON only). */
const csvBody = express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' });
const importQuery = z.object({ dry_run: z.enum(['true', 'false']).optional() });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/** The `{driver_id}` path parameter. Anything but a UUID cannot name a driver: 404. */
function driverId(req: Request): string {
  const id = req.params.driverId;
  if (!UUID.test(id)) throw driverNotFound();
  return id;
}

/** Drivers (api-contract §6.3): list, register, read, update and retire. */
export function driverRouter(service: DriverService): Router {
  const router = Router();

  router.get(
    '/drivers',
    authorize('driver:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(driverListQuery, req.query);
      const { items, total } = await service.list(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/drivers',
    authorize('driver:write'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const driver = await service.create(caller(req), parseInput(driverCreateBody, req.body));
      res
        .status(201)
        .location(`/api/v1/drivers/${driver.id}`)
        .set('ETag', etagFor(driver.version))
        .json({ data: driver, meta: { request_id: req.correlationId } });
    }),
  );

  // Bulk onboarding: a CSV of drivers, all registered or none (rules: DriverService.importDrivers).
  router.post(
    '/drivers/import',
    authorize('driver:write'),
    csvBody,
    idempotent(),
    asyncHandler(async (req, res) => {
      if (typeof req.body !== 'string' || req.body.trim() === '') {
        throw validationFailed([{ field: 'body', reason: 'csv_required' }], 'Send the drivers as CSV with Content-Type: text/csv.');
      }
      const dryRun = parseInput(importQuery, req.query).dry_run === 'true';
      const { rows, problems } = parseDriverImport(req.body);
      const result = await service.importDrivers(caller(req), rows, problems, dryRun);
      res.status('created' in result ? 201 : 200).json({ data: result, meta: { request_id: req.correlationId } });
    }),
  );

  // Registered before /drivers/:driverId, which would otherwise take "me" as an id.
  // Any signed-in user: drivers do not hold driver:read, but may see their own profile.
  router.get(
    '/drivers/me',
    authenticated(),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.me(caller(req)), meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/drivers/:driverId',
    authorize('driver:read'),
    asyncHandler(async (req, res) => {
      const driver = await service.get(caller(req), driverId(req));
      res.set('ETag', etagFor(driver.version)).json({ data: driver, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/drivers/:driverId',
    authorize('driver:write'),
    asyncHandler(async (req, res) => {
      const id = driverId(req);
      const expected = ifMatchVersion(req.get('If-Match'));
      const driver = await service.update(caller(req), id, parseInput(driverUpdateBody, req.body), expected);
      res.set('ETag', etagFor(driver.version)).json({ data: driver, meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/drivers/:driverId/reinstate',
    authorize('driver:write'),
    asyncHandler(async (req, res) => {
      const driver = await service.reinstate(caller(req), driverId(req));
      res.set('ETag', etagFor(driver.version)).json({ data: driver, meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/drivers/:driverId',
    authorize('driver:delete'),
    asyncHandler(async (req, res) => {
      await service.retire(caller(req), driverId(req));
      res.status(204).end();
    }),
  );

  return router;
}
