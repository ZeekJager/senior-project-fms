import { WebhookPayloadError, type ProviderAdapter } from '../domain/adapter';
import { telematicsDelivery } from '../domain/ping-schema';

/** The webhook kind of a delivery of positions; the GPS consumer takes these. */
export const POSITIONS_KIND = 'positions';

/**
 * The adapter for any telematics provider without one of its own (FMS-88): reads the FMS telematics
 * webhook format, `{ event_id, positions: [{ device_id, recorded_at, lat, lng, speed_kmh, ... }] }`.
 * A provider with its own format gets its own adapter, registered by its code, which wins over this.
 */
export function fmsTelematicsAdapter(code: string): ProviderAdapter {
  return {
    code,
    normalize(body) {
      const parsed = telematicsDelivery.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new WebhookPayloadError(issue.path.join('.') || 'body', issue.code === 'unrecognized_keys' ? 'not_expected' : issue.code);
      }
      const { event_id, positions } = parsed.data;
      const latest = positions.reduce((max, p) => (Date.parse(p.recorded_at) > max ? Date.parse(p.recorded_at) : max), 0);
      return { eventId: event_id, kind: POSITIONS_KIND, occurredAt: new Date(latest), data: { positions } };
    },
  };
}
