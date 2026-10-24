import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { FLOAT_IN_MONEY_PATH, parseInput, rejectFractionalMoney } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { InventoryService } from '../application/inventory.service';
import type { Caller } from '../application/maintenance.service';
import { SERVICE_ITEMS, partNotFoundById } from '../domain/inventory';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STOCK = 1_000_000;

const cents = z
  .number()
  .refine(Number.isInteger, { message: 'Whole cents.', params: { reason: FLOAT_IN_MONEY_PATH } })
  .refine((n) => n >= 0 && n <= 2_147_483_647, { message: 'Between 0 and 2147483647.', params: { reason: 'out_of_range' } });

/** Part numbers are how the workshop names a part: trimmed and upper case, letters, digits, - . / _ */
const partNumber = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9 ./_-]*$/, 'Letters, digits, spaces and - . / _'));

const optionalText = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional();

const fields = {
  part_number: partNumber,
  name: z.string().trim().min(1).max(255),
  description: optionalText(2000),
  depot_id: z.uuid().nullable().optional(),
  unit_cost_cents: cents.nullable().optional(),
  reorder_threshold: z.number().int().min(0).max(MAX_STOCK).optional(),
  // What the part renews (FMS-52): the predictive model reads each item's last change from repairs that used it.
  service_item: z.enum(SERVICE_ITEMS).nullable().optional(),
};

/** POST /inventory: a new part, with optional opening stock. */
const createBody = rejectFractionalMoney(z.strictObject({ ...fields, stock_quantity: z.number().int().min(0).max(MAX_STOCK).optional() }));

/** PUT /inventory/{id}: the fields sent. Stock is not here: it moves through adjust (and repairs). */
const updateBody = rejectFractionalMoney(
  z
    .strictObject({ ...fields, is_active: z.boolean() })
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } }),
);

/** POST /inventory/{id}/adjust: + in, - out, never 0; the reason is kept in the ledger. */
const adjustBody = z.strictObject({
  quantity: z
    .number()
    .int()
    .min(-MAX_STOCK)
    .max(MAX_STOCK)
    .refine((n) => n !== 0, { message: 'Positive to add stock, negative to remove it.', params: { reason: 'zero' } }),
  reason: z.string().trim().min(3).max(500),
});

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

/** GET /inventory. `belowReorder` (the card) and `below_reorder` (the contract) are the same filter. */
const listQuery = z
  .object({
    ...pageQuery,
    depot_id: z.uuid().optional(),
    below_reorder: flag.optional(),
    belowReorder: flag.optional(),
    stock_status: z.enum(['out', 'low', 'ok']).optional(),
    search: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((s) => s || undefined),
    status: z.enum(['active', 'inactive', 'all']).default('active'),
    sort_by: z.enum(['part_number', 'name', 'stock_quantity']).default('part_number'),
    sort_order: z.enum(['asc', 'desc']).default('asc'),
  })
  .transform(({ belowReorder, below_reorder, ...rest }) => ({ ...rest, below_reorder: below_reorder ?? belowReorder }));

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function partId(req: Request): string {
  const id = req.params.partId;
  if (!UUID.test(id)) throw partNotFoundById();
  return id;
}

/**
 * Spare parts inventory (api-contract §10.1, FMS-23). The card's /inventory
 * and the contract's /inventory/parts are the same list. Reads need
 * inventory:read, writes inventory:write (admin, fleet manager, depot admin,
 * technician): a driver gets 403 everywhere.
 */
export function inventoryRouter(service: InventoryService): Router {
  const router = Router();

  for (const path of ['/inventory', '/inventory/parts']) {
    router.get(
      path,
      authorize('inventory:read'),
      asyncHandler(async (req, res) => {
        const query = parseInput(listQuery, req.query);
        const { items, total } = await service.list(caller(req), query);
        res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
      }),
    );
  }

  router.post(
    '/inventory',
    authorize('inventory:write'),
    asyncHandler(async (req, res) => {
      const part = await service.create(caller(req), parseInput(createBody, req.body));
      res
        .status(201)
        .location(`/api/v1/inventory/${part.id}`)
        .set('ETag', etagFor(part.version))
        .json({ data: part, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/inventory/:partId',
    authorize('inventory:read'),
    asyncHandler(async (req, res) => {
      const part = await service.get(caller(req), partId(req));
      res.set('ETag', etagFor(part.version)).json({ data: part, meta: { request_id: req.correlationId } });
    }),
  );

  router.put(
    '/inventory/:partId',
    authorize('inventory:write'),
    asyncHandler(async (req, res) => {
      const id = partId(req);
      const part = await service.update(caller(req), id, parseInput(updateBody, req.body), ifMatchVersion(req.get('If-Match')));
      res.set('ETag', etagFor(part.version)).json({ data: part, meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/inventory/:partId/adjust',
    authorize('inventory:write'),
    asyncHandler(async (req, res) => {
      const part = await service.adjust(caller(req), partId(req), parseInput(adjustBody, req.body));
      res.set('ETag', etagFor(part.version)).json({ data: part, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/inventory/:partId/movements',
    authorize('inventory:read'),
    asyncHandler(async (req, res) => {
      const page = parseInput(z.object(pageQuery), req.query);
      const { items, total } = await service.movements(caller(req), partId(req), page);
      res.json({ data: items, meta: { ...pageMeta(page, total), request_id: req.correlationId } });
    }),
  );

  return router;
}
