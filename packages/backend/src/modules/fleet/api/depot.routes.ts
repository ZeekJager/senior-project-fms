import { Router, type Request } from 'express';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { idempotent } from '../../../shared/http/idempotency';
import { pageMeta } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authenticated, authorize } from '../../auth';
import type { Caller } from '../application/caller';
import type { DepotService } from '../application/depot.service';
import { depotNotFoundById } from '../domain/depot';
import { depotCreateBody, depotListQuery, depotUpdateBody } from './depot.schemas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/** The `{depot_id}` path parameter. Anything but a UUID cannot name a depot: 404. */
function depotId(req: Request): string {
  const id = req.params.depotId;
  if (!UUID.test(id)) throw depotNotFoundById();
  return id;
}

/**
 * Depots (api-contract §6.1, FMS-20). Reads: any signed-in user (everyone
 * filters by depot). Writes: depot:write, which admin and fleet_owner hold.
 */
export function depotRouter(service: DepotService): Router {
  const router = Router();

  router.get(
    '/depots',
    authenticated(),
    asyncHandler(async (req, res) => {
      const query = parseInput(depotListQuery, req.query);
      const { items, total } = await service.list(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/depots',
    authorize('depot:write'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const depot = await service.create(caller(req), parseInput(depotCreateBody, req.body));
      res
        .status(201)
        .location(`/api/v1/depots/${depot.id}`)
        .set('ETag', etagFor(depot.version))
        .json({ data: depot, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/depots/:depotId',
    authenticated(),
    asyncHandler(async (req, res) => {
      const depot = await service.get(caller(req), depotId(req));
      res.set('ETag', etagFor(depot.version)).json({ data: depot, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/depots/:depotId',
    authorize('depot:write'),
    asyncHandler(async (req, res) => {
      const id = depotId(req);
      const expected = ifMatchVersion(req.get('If-Match'));
      const depot = await service.update(caller(req), id, parseInput(depotUpdateBody, req.body), expected);
      res.set('ETag', etagFor(depot.version)).json({ data: depot, meta: { request_id: req.correlationId } });
    }),
  );

  // PUT (the FMS-20 card): a full replacement. Optional fields it leaves out are cleared.
  router.put(
    '/depots/:depotId',
    authorize('depot:write'),
    asyncHandler(async (req, res) => {
      const id = depotId(req);
      const expected = ifMatchVersion(req.get('If-Match'));
      const depot = await service.update(caller(req), id, parseInput(depotCreateBody, req.body), expected, true);
      res.set('ETag', etagFor(depot.version)).json({ data: depot, meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/depots/:depotId',
    authorize('depot:write'),
    asyncHandler(async (req, res) => {
      await service.remove(caller(req), depotId(req));
      res.status(204).end();
    }),
  );

  router.post(
    '/depots/:depotId/reactivate',
    authorize('depot:write'),
    asyncHandler(async (req, res) => {
      const depot = await service.reactivate(caller(req), depotId(req));
      res.set('ETag', etagFor(depot.version)).json({ data: depot, meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
