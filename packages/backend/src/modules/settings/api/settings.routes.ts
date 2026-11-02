import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authenticated, authorize } from '../../auth';
import type { Caller, SettingsService } from '../application/settings.service';
import { SETTING_KEYS, type SettingKey } from '../domain/settings';

const settingValue = z.number().int().nullable();

/** PATCH /settings: any non-empty subset of the settings, each a whole number or null (the default). */
const changesBody = z
  .strictObject(Object.fromEntries(SETTING_KEYS.map((k) => [k, settingValue.optional()])) as Record<SettingKey, z.ZodOptional<typeof settingValue>>)
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one setting to change.', params: { reason: 'empty_update' } });

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

/**
 * Settings (api-contract §16, FMS-80). Anyone signed in reads them (screens draw their lines); settings:write,
 * admin only, changes them.
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

  return router;
}
