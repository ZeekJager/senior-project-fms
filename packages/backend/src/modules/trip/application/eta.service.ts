import type { PoolClient } from 'pg';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { stepDelay, TRIP_DELAYED, type DelayMargins } from '../domain/delay';
import { etaFrom, etaRequest, MAX_POSITION_AGE_MS, TRIP_ETA_UPDATED, waypointsFor, type EtaResult } from '../domain/eta';
import { RoutingError, type RoadPlanner } from '../infrastructure/osrm.planner';
import type { EtaTrip, TripRepository } from '../infrastructure/trip.repository';

/** What the delay alert (FMS-147) needs: the margins of a depot (internal id; null: the fleet's), and public ids. */
export interface DelayDeps {
  margins: (db: Queryable, depotId: string | null) => Promise<DelayMargins>;
  publicIds: {
    depots(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
    vehicles(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
    drivers(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
}

export interface EtaServiceDeps {
  trips: Pick<TripRepository, 'etaTrip' | 'claimEstimate' | 'markStopsReached' | 'saveEstimate' | 'delayState' | 'saveDelayState'>;
  events: EventBus;
  /** The routing engine (FMS-84), or null when ROUTING_URL is not set: stops are still marked reached, no times. */
  roads: () => RoadPlanner | null;
  /** Why an estimate could not be made (the engine down or unreachable). */
  warn: (fields: Record<string, unknown>, message: string) => void;
  /** The delay alert's margins and lookups; null (not connected yet): no trip is judged late. */
  delay: () => DelayDeps | null;
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
 *
 * Each new arrival time is then held against the trip's scheduled end (FMS-147): past the depot's margin, the trip
 * falls late and TripDelayed goes out; past the second margin, again as urgent. Only a fresh position makes an
 * estimate, so a trip whose vehicle went quiet is never judged on its old one.
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
    await this.judgeDelay(tx, trip, result, positionAt, event.correlation_id);
  }

  /** The new arrival time against the scheduled end (FMS-147): TripDelayed when the trip falls late or becomes urgent. */
  private async judgeDelay(tx: PoolClient, trip: EtaTrip, result: EtaResult, positionAt: Date, correlationId: string): Promise<void> {
    const delay = this.deps.delay();
    if (!delay || !result.arrivalAt || !trip.scheduledEnd) return;
    const { trips } = this.deps;
    const margins = await delay.margins(tx, trip.depotId);
    const current = await trips.delayState(tx, trip.id);
    const step = stepDelay(current, result.arrivalAt, trip.scheduledEnd, margins);
    if (step.state.level !== current.level || step.state.episode !== current.episode) await trips.saveDelayState(tx, trip.id, step.state);
    if (!step.raise) return;

    const one = async (lookup: (db: Queryable, ids: readonly string[]) => Promise<Map<string, string>>, id: string | null) =>
      id === null ? null : ((await lookup(tx, [id])).get(id) ?? null);
    // One after another: the lookups share the transaction's connection.
    const depotId = await one(delay.publicIds.depots, trip.depotId);
    const vehicleId = await one(delay.publicIds.vehicles, trip.vehicleId);
    const driverId = await one(delay.publicIds.drivers, trip.driverId);
    await this.deps.events.publish(tx, [
      createEvent(
        TRIP_DELAYED,
        {
          trip_id: trip.publicId,
          depot_id: depotId,
          vehicle_id: vehicleId,
          driver_id: driverId,
          level: step.raise,
          episode: step.state.episode,
          late_minutes: step.lateByMinutes,
          margin_minutes: step.raise === 'urgent' ? margins.urgentMinutes : margins.lateMinutes,
          scheduled_end: trip.scheduledEnd.toISOString(),
          arrival_at: result.arrivalAt.toISOString(),
          destination: trip.destinationName,
          position_at: positionAt.toISOString(),
        },
        { actor: null, correlationId },
        { aggregate: aggregateKey('trip', trip.publicId) },
      ),
    ]);
  }
}
