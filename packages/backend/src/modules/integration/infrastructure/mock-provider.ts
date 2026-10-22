import { z } from 'zod';
import { WebhookPayloadError, type ProviderAdapter } from '../domain/adapter';

// The mock provider (FMS-85): a complete adapter against a small HTTP API, for tests and as the
// template for a real one. Registered only by tests (the gateway's tests run it against a local
// server that can be told to be slow or fail); nothing registers it in a running API.
//
//   GET /health  -> 2xx when up
//   GET /sync    -> { records: number, batch_id?: string }, with Authorization: Bearer <api key>
//   webhook body -> { event_id, kind, occurred_at?, data }

const syncAnswer = z.object({ records: z.number().int().min(0), batch_id: z.string().min(1).max(255).optional() });

const webhookBody = z.strictObject({
  event_id: z.string().min(1).max(255),
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  data: z.record(z.string(), z.unknown()),
});

export function mockProviderAdapter(code: string): ProviderAdapter {
  return {
    code,
    async healthCheck(ctx) {
      await ctx.client.call({ method: 'GET', path: '/health' });
    },
    async sync(ctx) {
      const res = await ctx.client.call({ method: 'GET', path: '/sync', headers: ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {} });
      const body = syncAnswer.parse(res.body);
      return { status: 'succeeded', records: body.records, externalReference: body.batch_id };
    },
    normalize(body) {
      const parsed = webhookBody.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new WebhookPayloadError(issue.path.join('.') || 'body', issue.code === 'unrecognized_keys' ? 'not_expected' : issue.code);
      }
      const { event_id, kind, occurred_at, data } = parsed.data;
      return { eventId: event_id, kind, occurredAt: occurred_at ? new Date(occurred_at) : null, data };
    },
  };
}
