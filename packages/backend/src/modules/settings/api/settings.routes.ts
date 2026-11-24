import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { parseInput } from '../../../shared/http/validate';
import { authenticated, authorize } from '../../auth';
import type { Caller, ParameterPatch, SettingsService } from '../application/settings.service';
import { PARAMETER_TYPES } from '../domain/parameter-types';
import type { ParameterView } from '../domain/registry';

/** PATCH /settings: any non-empty set of parameters by key, each a value or null (the default). The service checks each against its type. */
const changesBody = z
  .record(z.string().max(80), z.unknown())
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one setting to change.', params: { reason: 'empty_update' } });

/** A definition's rules: their keys and values are checked for the type by the service (checkDefinition). */
const rules = z.record(z.string().max(40), z.unknown());

const defineBody = z.strictObject({
  key: z.string().max(80),
  label: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(60),
  description: z.string().max(1000).optional(),
  type: z.enum(PARAMETER_TYPES),
  default_value: z.unknown().optional(),
  rules: rules.optional(),
  is_enabled: z.boolean().optional(),
  is_secret: z.boolean().optional(),
  required_permission: z.string().max(100).nullable().optional(),
  value: z.unknown().optional(),
});

const patchBody = z
  .strictObject({
    label: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    description: z.string().max(1000).optional(),
    default_value: z.unknown().optional(),
    rules: rules.optional(),
    required_permission: z.string().max(100).nullable().optional(),
    is_enabled: z.boolean().optional(),
    value: z.unknown().optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'reason'), { message: 'Send something to change.', params: { reason: 'empty_update' } });

const listQuery = z.strictObject({
  category: z.string().max(60).optional(),
  q: z.string().max(100).optional(),
  /** true: only those with a value of their own; false: only those at their default. */
  changed: z.enum(['true', 'false']).optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/** The fields the body has, `value` and `default_value` included when sent as null: present is not the same as undefined. */
function present<T extends object>(parsed: T, raw: unknown, keys: readonly string[]): T {
  const out = { ...parsed } as Record<string, unknown>;
  const body = (raw ?? {}) as Record<string, unknown>;
  for (const k of keys) {
    if (k in body) out[k] = body[k] ?? null;
    else delete out[k];
  }
  return out as T;
}

function matches(p: ParameterView, q: z.infer<typeof listQuery>): boolean {
  if (q.category && p.category !== q.category) return false;
  if (q.changed && p.is_default === (q.changed === 'true')) return false;
  if (q.enabled && p.is_enabled !== (q.enabled === 'true')) return false;
  if (q.q) {
    const needle = q.q.trim().toLowerCase();
    if (![p.key, p.label, p.category, p.description].some((s) => s.toLowerCase().includes(needle))) return false;
  }
  return true;
}

/**
 * Settings (api-contract §16, FMS-80) and their registry (FMS-157). Anyone signed in reads the values (screens draw
 * their lines from them; a secret's never); settings:write changes values; settings:define adds, edits, enables,
 * disables and deletes parameters.
 */
export function settingsRouter(service: SettingsService): Router {
  const router = Router();

  router.get(
    '/settings',
    authenticated(),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.list(), meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/settings',
    authorize('settings:write'),
    asyncHandler(async (req, res) => {
      const changes = parseInput(changesBody, req.body ?? {});
      res.json({ data: await service.update(caller(req), changes), meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/settings/definitions',
    authenticated(),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const all = await service.definitions();
      res.json({
        data: all.filter((p) => matches(p, query)),
        meta: { request_id: req.correlationId, categories: [...new Set(all.map((p) => p.category))].sort() },
      });
    }),
  );

  router.post(
    '/settings/definitions',
    authorize('settings:define'),
    asyncHandler(async (req, res) => {
      const body = present(parseInput(defineBody, req.body ?? {}), req.body, ['default_value', 'value']);
      const view = await service.define(caller(req), body);
      res
        .status(201)
        .location(`/api/v1/settings/definitions/${view.key}`)
        .set('ETag', etagFor(view.version))
        .json({ data: view, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/settings/definitions/:key',
    authenticated(),
    asyncHandler(async (req, res) => {
      const view = await service.definition(req.params.key);
      res.set('ETag', etagFor(view.version)).json({ data: view, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/settings/definitions/:key',
    authorize('settings:write', 'settings:define'),
    asyncHandler(async (req, res) => {
      const patch = present(parseInput(patchBody, req.body ?? {}), req.body, ['default_value', 'value']) as ParameterPatch;
      const expected = ifMatchVersion(req.get('If-Match'));
      const view = await service.updateDefinition(caller(req), req.params.key, patch, expected);
      res.set('ETag', etagFor(view.version)).json({ data: view, meta: { request_id: req.correlationId } });
    }),
  );

  router.delete(
    '/settings/definitions/:key',
    authorize('settings:define'),
    asyncHandler(async (req, res) => {
      await service.remove(caller(req), req.params.key, ifMatchVersion(req.get('If-Match')));
      res.status(204).end();
    }),
  );

  router.get(
    '/settings/definitions/:key/history',
    authorize('settings:write', 'settings:define'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.history(req.params.key), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
