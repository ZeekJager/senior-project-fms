import { WebhookPayloadError, type ProviderAdapter } from '../domain/adapter';
import { telematicsDelivery } from '../domain/ping-schema';

/** The webhook kind of a delivery of positions; the GPS consumer takes these. */
export const POSITIONS_KIND = 'positions';
/** The webhook kind of a delivery of diagnostic trouble codes only (FMS-132). */
export const DIAGNOSTICS_KIND = 'diagnostics';

/**
 * The adapter for any telematics provider without one of its own (FMS-88): reads the FMS telematics
 * webhook format, `{ event_id, positions: [{ device_id, recorded_at, lat, lng, speed_kmh, ... }],
 * diagnostics: [{ device_id, protocol, code | spn + fmi, status, observed_at }] }`, either list or both.
 * A delivery with positions is of kind `positions` (its codes ride along in `data.diagnostics`); one with
 * codes only is of kind `diagnostics`. A provider with its own format gets its own adapter, registered by
 * its code, which wins over this.
 */
export function fmsTelematicsAdapter(code: string): ProviderAdapter {
  return {
    code,
    normalize(body) {
      const parsed = telematicsDelivery.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const reason = issue.code === 'unrecognized_keys' ? 'not_expected' : issue.code === 'custom' ? 'required' : issue.code;
        throw new WebhookPayloadError(issue.path.join('.') || 'body', reason);
      }
      const { event_id, positions, diagnostics } = parsed.data;
      const times = [...(positions ?? []).map((p) => Date.parse(p.recorded_at)), ...(diagnostics ?? []).map((d) => Date.parse(d.observed_at))];
      const latest = times.reduce((max, t) => (t > max ? t : max), 0);
      return {
        eventId: event_id,
        kind: positions ? POSITIONS_KIND : DIAGNOSTICS_KIND,
        occurredAt: new Date(latest),
        data: { ...(positions ? { positions } : {}), ...(diagnostics ? { diagnostics } : {}) },
      };
    },
  };
}
