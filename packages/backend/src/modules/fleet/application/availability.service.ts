import type { PoolClient } from 'pg';
import {
  MAX_WINDOW_DAYS,
  driverAvailability,
  invalidWindow,
  vehicleAvailability,
  type AvailabilityResult,
  type AvailabilityWindow,
} from '../domain/availability';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RebuildResult, availabilityStore as Store, TripState } from '../infrastructure/availability.repository';

export interface AvailabilityQuery {
  /** Internal fleet.vehicles ids. */
  vehicleIds?: readonly string[];
  /** Internal fleet.drivers ids. */
  driverIds?: readonly string[];
  window: AvailabilityWindow;
  /** A trip (public id) whose own assignment is not a conflict: the one being re-assigned. */
  excludeTripId?: string;
  /**
   * The depot (internal id) of the trip being staffed: a vehicle or driver of
   * another depot is then unavailable (vehicle_other_depot, driver_other_depot).
   * Omitted: any depot.
   */
  depotId?: string;
}

/** Per id; ids that do not exist are absent. */
export interface AvailabilityAnswer {
  vehicles: Map<string, AvailabilityResult>;
  drivers: Map<string, AvailabilityResult>;
}

export interface AvailabilityServiceDeps {
  store: typeof Store;
  /** The trip module's reads (through its index.ts): one trip's state, and every trip holding a vehicle or driver. */
  trips: {
    tripAssignment(db: Queryable, tripPublicId: string): Promise<TripState | null>;
    activeAssignments(db: Queryable): Promise<TripState[]>;
  };
  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

/**
 * Availability (FMS-76): one answer to "is this vehicle or driver free for
 * this window", for the dispatcher console (FMS-33) and trip assignment
 * (FMS-31). It combines the vehicle's status and maintenance flag, the
 * driver's account, licence and attendance, and fleet's read model of the
 * trips holding each of them. With a depot, it also keeps each depot's trips
 * to its own vehicles and drivers.
 */
export class AvailabilityService {
  constructor(private readonly deps: AvailabilityServiceDeps) {}

  /**
   * Availability of these vehicles and drivers for the window, read on `db`
   * (pass the caller's transaction client to read inside it). A window ends at
   * or after it starts (a single instant is allowed) and spans at most
   * MAX_WINDOW_DAYS days; otherwise 400 VALIDATION_INVALID_DATE_RANGE.
   */
  async check(db: Queryable, query: AvailabilityQuery): Promise<AvailabilityAnswer> {
    const { start, end } = query.window;
    if (end < start) throw invalidWindow('The window must end at or after its start.');
    if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * 86_400_000) throw invalidWindow(`A window covers at most ${MAX_WINDOW_DAYS} days.`);
    const vehicleFacts = await this.deps.store.vehicleFacts(db, query.vehicleIds ?? [], query.window, query.excludeTripId);
    const driverFacts = await this.deps.store.driverFacts(db, query.driverIds ?? [], query.window, query.excludeTripId);
    return {
      vehicles: new Map([...vehicleFacts].map(([id, facts]) => [id, vehicleAvailability(facts, query.depotId)])),
      drivers: new Map([...driverFacts].map(([id, facts]) => [id, driverAvailability(facts, query.depotId)])),
    };
  }

  /**
   * The fleet.trip-assignments projection: a trip changed, so bring its row
   * in the read model in line with the trip's state, inside the trip
   * change's transaction. The event says which trip; the trip module says
   * what is true, so the row matches the trip whatever the event says.
   */
  async onTripEvent(tx: Queryable, tripPublicId: string): Promise<void> {
    await this.deps.store.apply(tx, await this.deps.trips.tripAssignment(tx, tripPublicId), tripPublicId);
  }

  /**
   * Rebuilds the read model from the trip module (the daily job, and
   * rebuildReadModels after the seed or an import). `repaired` or `removed`
   * above zero means trips changed without their events.
   */
  resync(): Promise<RebuildResult> {
    return this.deps.inTransaction(async (client) => this.deps.store.replaceAll(client, await this.deps.trips.activeAssignments(client)));
  }
}
