import type { PoolClient } from 'pg';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { etaFrom, etaRequest, MAX_POSITION_AGE_MS, TRIP_ETA_UPDATED, waypointsFor, type EtaResult } from '../domain/eta';
import { RoutingError, type RoadPlanner } from '../infrastructure/osrm.planner';
import type { TripRepository } from '../infrastructure/trip.repository';

export interface EtaServiceDeps {
  trips: Pick<TripRepository, 'etaTrip' | 'claimEstimate' | 'markStopsReached' | 'saveEstimate'>;
  events: EventBus;
  /** The routing engine (FMS-84), or null when ROUTING_URL is not set: stops are still marked reached, no times. */
  roads: () => RoadPlanner | null;
  /** Why an estimate could not be made (the engine down or unreachable). */
  warn: (fields: Record<string, unknown>, message: string) => void;
  now?: () => number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Live arrival times (FMS-86, docs/eta.md). On each announced position of a trip under way (VehicleLocationUpdated,
 * itself throttled per vehicle), at most once per 30 seconds of position time per trip: the stops the vehicle has
 * reached are marked arrived, the road from the position through the stops ahead to the destination is measured,
 * and each stop and the trip get an arrival time, published as TripEtaUpdated. When the engine cannot be asked
 * the last estimate stays, and the event is not retried: the next position asks again.
 */
export class EtaService {
  private readonly now: () => number;

  constructor(private readonly deps: EtaServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async onLocationUpdated(tx: PoolClient, event: DomainEvent): Promise<void> {
    const tripId = str(event.payload.trip_id);
    const lat = num(event.payload.lat);
    const lng = num(event.payload.lng);
    const positionAt = new Date(str(event.payload.recorded_at) ?? event.occurred_at);
    if (!tripId || lat === null || lng === null || Number.isNaN(positionAt.getTime())) return;
    if (this.now() - positionAt.getTime() > MAX_POSITION_AGE_MS) return;

    const { trips } = this.deps;
    const trip = await trips.etaTrip(tx, tripId);
    if (!trip || trip.status !== 'en_route') return;
    if (!(await trips.claimEstimate(tx, trip.id, positionAt))) return;

    const position = { latitude: lat, longitude: lng };
    const request = etaRequest(position, trip.stops, trip.destination);
    await trips.markStopsReached(tx, trip.id, request.reached, positionAt);

    const points = waypointsFor(position, request);
    let result: EtaResult;
    if (points.length < 2) {
      result = etaFrom(request, [], positionAt);
    } else {
      const roads = this.deps.roads();
      if (!roads) return;
      let legs;
      try {
        legs = await roads.legs(points, event.correlation_id);
      } catch (err) {
        if (!(err instanceof RoutingError)) throw err;
        this.deps.warn({ err, trip_id: tripId }, 'trip ETA: the routing engine could not be asked; the last estimate stays');
        return;
      }
      if (!legs) return;
      result = etaFrom(request, legs, positionAt);
    }

    await trips.saveEstimate(tx, trip.id, result, positionAt, new Date(this.now()));
    await this.deps.events.publish(tx, [
      createEvent(
        TRIP_ETA_UPDATED,
        {
          trip_id: tripId,
          arrival_at: result.arrivalAt?.toISOString() ?? null,
          remaining_km: result.remainingKm,
          remaining_seconds: result.remainingSeconds,
          position_at: positionAt.toISOString(),
          stops: result.stops.map((s) => ({ stop_id: s.id, eta: s.eta.toISOString() })),
          reached_stop_ids: request.reached,
        },
        { actor: null, correlationId: event.correlation_id },
        { aggregate: aggregateKey('trip', tripId) },
      ),
    ]);
  }
}
