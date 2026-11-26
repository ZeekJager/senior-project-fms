import { WebhookPayloadError, type ProviderAdapter } from '../domain/adapter';
import { evChargingDelivery } from '../domain/ev-charging-schema';

/** The provider code of the simulated charging network (migration 084): its deliveries are synthetic. */
export const SIMULATED_CHARGING_PROVIDER = 'simulated';

/**
 * The adapter for any EV charging provider without one of its own (FMS-97): reads the FMS EV charging webhook format
 * (domain/ev-charging-schema.ts). The simulated provider (`simulated`) speaks it, so a real network that speaks it
 * too replaces the simulator without a change to the EV module; one with its own format gets its own adapter,
 * registered by its code, which wins over this. The EV module consumes the deliveries (ev.charging-webhooks).
 */
export function fmsEvChargingAdapter(code: string): ProviderAdapter {
  return {
    code,
    normalize(body) {
      const parsed = evChargingDelivery.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new WebhookPayloadError(issue.path.join('.') || 'body', issue.code === 'unrecognized_keys' ? 'not_expected' : issue.code);
      }
      const { event_id, type, occurred_at, session } = parsed.data;
      return { eventId: event_id, kind: type, occurredAt: new Date(occurred_at), data: { session, synthetic: code === SIMULATED_CHARGING_PROVIDER } };
    },
  };
}
