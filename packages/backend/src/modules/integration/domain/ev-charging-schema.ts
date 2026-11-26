import { z } from 'zod';

/**
 * The FMS EV charging webhook format (FMS-97, docs/ev.md#the-charging-webhook): what a charging provider sends to
 * POST /webhooks/ev/{code}, one session event a delivery. Each delivery carries the whole session as the provider
 * sees it then, so deliveries that arrive late, twice or out of order still leave the session right.
 *
 *   { "event_id": "sim-…", "type": "session_completed", "occurred_at": "2026-11-26T18:40:00+03:00",
 *     "session": { "session_id": "sim-s-…", "vehicle_id": "<the vehicle's FMS id>", "station_id": "SIM-ST-03",
 *                  "started_at": "…", "ended_at": "…", "energy_kwh": 41.2, "cost_cents": 49440,
 *                  "start_soc": 18, "end_soc": 80 } }
 */
export const EV_SESSION_KINDS = ['session_started', 'session_completed', 'session_failed'] as const;
export type EvSessionKind = (typeof EV_SESSION_KINDS)[number];

const instant = z.iso.datetime({ offset: true });
const percent = z.number().min(0).max(100);

export const evChargingDelivery = z.strictObject({
  event_id: z.string().trim().min(1).max(255),
  type: z.enum(EV_SESSION_KINDS),
  occurred_at: instant,
  session: z.strictObject({
    session_id: z.string().trim().min(1).max(255),
    /** The vehicle's FMS id (public UUID), given to the provider when the vehicle joined its network. */
    vehicle_id: z.uuid(),
    /** The provider's own id for the station, as it is in ev.charging_stations.external_station_id. */
    station_id: z.string().trim().min(1).max(255).nullish(),
    started_at: instant.nullish(),
    ended_at: instant.nullish(),
    energy_kwh: z.number().min(0).max(10_000).nullish(),
    // Whole cents (api-contract §3.5).
    cost_cents: z.number().int().min(0).max(100_000_000).nullish(),
    start_soc: percent.nullish(),
    end_soc: percent.nullish(),
  }),
});

export type EvChargingDelivery = z.infer<typeof evChargingDelivery>;
/** A delivery's session, as the EV module's consumer reads it from the stored delivery. */
export type EvProviderSession = EvChargingDelivery['session'];
