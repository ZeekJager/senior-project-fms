import { z } from 'zod';
import { MAX_PINGS_PER_BATCH, MAX_SPEED_KMH } from './gps';

/**
 * A position's fields, the same from the API and from a telematics webhook: ranges a ping must be
 * inside to be read at all. A batch with one out of range is refused whole (400 naming it); a ping that
 * is readable but not usable (stale, imprecise) is refused alone (`pingProblem`).
 */
const positionFields = {
  recorded_at: z.iso.datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speed_kmh: z.number().min(0).max(MAX_SPEED_KMH),
  heading: z.number().min(0).max(360).nullish(),
  accuracy_m: z.number().min(0).max(100_000).nullish(),
  altitude_m: z.number().min(-1_000).max(10_000).nullish(),
  ignition_on: z.boolean().nullish(),
  odometer_km: z.number().min(0).max(99_999_999_999).nullish(),
};

/** POST /tracking/gps-pings: `vehicle_id` is required from a user, implied for a device or a phone. */
export const apiPingBatch = z.strictObject({
  pings: z
    .array(z.strictObject({ vehicle_id: z.uuid().optional(), ...positionFields }))
    .min(1)
    .max(MAX_PINGS_PER_BATCH),
});

/**
 * The FMS telematics webhook format (docs/integrations.md): what a provider sends, or what a relay in
 * front of a provider translates its own format to. Devices are named by the provider's identifier.
 */
export const telematicsDelivery = z.strictObject({
  event_id: z.string().min(1).max(255),
  positions: z
    .array(z.strictObject({ device_id: z.string().min(1).max(255), ...positionFields }))
    .min(1)
    .max(MAX_PINGS_PER_BATCH),
});
