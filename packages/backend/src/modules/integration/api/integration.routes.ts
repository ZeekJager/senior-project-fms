import { Router, type Request } from 'express';
import { z } from 'zod';
import { webhookChannel } from '../../../middleware/requestSource';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize, publicRoute } from '../../auth';
import type { IntegrationService } from '../application/integration.service';
import type { ProviderType } from '../domain/adapter';
import { providerNotFound, webhookNotJson } from '../domain/provider';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listQuery = z.object({ check: z.enum(['true', 'false']).default('false') });

/** The webhook paths of api-contract §15.1, and the provider type each accepts. */
export const WEBHOOK_PATHS: Record<string, ProviderType> = {
  telematics: 'telematics',
  'fuel-card': 'fuel_card',
  ev: 'ev_charging',
};

/**
 * Provider status and manual sync (api-contract §15.1, FMS-85): integration:read and
 * integration:execute, which admins and fleet managers hold.
 */
export function integrationRouter(service: IntegrationService): Router {
  const router = Router();

  router.get(
    '/integrations/providers',
    authorize('integration:read'),
    asyncHandler(async (req, res) => {
      const { check } = parseInput(listQuery, req.query);
      res.json({ data: await service.listProviders(check === 'true', req.correlationId), meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/integrations/providers/:providerId/sync',
    authorize('integration:execute'),
    asyncHandler(async (req, res) => {
      if (!UUID.test(req.params.providerId)) throw providerNotFound();
      const { log, alreadyRunning } = await service.sync({ user: req.user!, correlationId: req.correlationId }, req.params.providerId);
      res.status(202).json({ data: log, meta: { request_id: req.correlationId, already_running: alreadyRunning } });
    }),
  );

  return router;
}

/**
 * Signed webhooks (api-contract §15.1). Public routes: the caller is a provider, authenticated by
 * its HMAC signature, not a session. Their audit rows say channel `webhook`. The raw body (what the
 * provider signed) is kept by the JSON parser for these paths only (app.ts).
 */
export function webhookRouter(service: IntegrationService): Router {
  const router = Router();
  for (const [segment, providerType] of Object.entries(WEBHOOK_PATHS)) {
    router.post(
      `/webhooks/${segment}/:provider`,
      publicRoute(),
      webhookChannel,
      asyncHandler(async (req, res) => {
        if (!req.is('application/json') || !req.rawBody) throw webhookNotJson();
        const result = await service.receiveWebhook({
          providerType,
          code: req.params.provider,
          rawBody: req.rawBody,
          body: req.body,
          header: (name: string) => req.get(name),
          correlationId: req.correlationId,
        });
        res.status(202).json({ data: { id: result.id, status: 'accepted', duplicate: result.duplicate }, meta: { request_id: req.correlationId } });
      }),
    );
  }
  return router;
}

/** Only these paths keep their raw body: every other request is parsed and the bytes dropped. */
export const keepsRawBody = (req: Request) => req.originalUrl.startsWith('/api/v1/webhooks/');
