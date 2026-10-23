import { depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import {
  CLOCK_SKEW_MS,
  FUEL_EVENTS,
  MAX_FUELED_AGE_DAYS,
  driverNotWritable,
  electricVehicle,
  fuelDriverNotFound,
  fuelLogNotFound,
  fuelTripNotFound,
  fuelVehicleNotFound,
  fuelVehicleRetired,
  fueledInFuture,
  fueledTooOld,
  noDriverProfile,
  odometerAheadOfLater,
  odometerRegression,
  tripVehicleMismatch,
  type FuelLogView,
  type FuelType,
} from '../domain/fuel-log';
import type { FuelLogRepository, FuelLogRow, FuelVisibility } from '../infrastructure/fuel-log.repository';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

/** POST /fuel-logs. Volume in millilitres, money in cents, the odometer in km (one decimal). */
export interface FuelLogCreate {
  /** Public id of a vehicle in the caller's depots. */
  vehicle_id: string;
  /** A trip the caller may see; if it has a vehicle it must be this one. */
  trip_id?: string;
  /** Staff may name the driver who filled up; a driver is always themselves. */
  driver_id?: string;
  /** Defaults to the vehicle's fuel type. */
  fuel_type?: FuelType;
  quantity_ml: number;
  total_cost_cents: number;
  unit_price_cents?: number;
  odometer_km: number;
  station_name?: string;
  /** When the fill-up happened (FMS-115): the form's submit time, however late the offline queue delivers it. Defaults to now. */
  fueled_at?: Date;
}

export interface FuelLogListQuery {
  page: number;
  page_size: number;
  vehicle_id?: string;
  driver_id?: string;
  trip_id?: string;
  from?: Date;
  to?: Date;
  sort_order: 'asc' | 'desc';
}

/**
 * What the fuel module needs from fleet and trip: vehicles and drivers by
 * public id inside a scope, and trips a user may see. Connected in
 * src/modules/fuel/index.ts (fleet and trip never import fuel).
 */
export interface FuelRefs {
  vehicles: {
    /** Row-locks the vehicle, so two logs for it are checked one after the other. */
    lockInScope(
      client: Queryable,
      publicId: string,
      scope: Scope,
    ): Promise<{ id: string; isActive: boolean; fuelType: FuelType; odometerKm: number } | null>;
    refInScope(db: Queryable, publicId: string, scope: Scope): Promise<{ id: string; publicId: string } | null>;
    /** Internal ids of a scope's vehicles; null means every vehicle. */
    idsInScope(db: Queryable, scope: Scope): Promise<string[] | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  drivers: {
    idOfUser(db: Queryable, userId: string): Promise<string | null>;
    findInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  trips: {
    find(db: Queryable, user: RequestUser, publicId: string): Promise<{ id: string; vehicleId: string | null; driverId: string | null } | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
}

export interface FuelLogServiceDeps {
  logs: Pick<FuelLogRepository, 'inTransaction' | 'list' | 'findVisible' | 'findById' | 'lastOdometer' | 'nextOdometer' | 'insert'>;
  refs: FuelRefs;
  events: EventBus;
}

/**
 * Fuel logs (FMS-39, §9.3): each purchase with what cost-per-km and anomaly
 * detection need. A driver records and reads only their own logs; staff see
 * the logs of their depots' vehicles. A log is never edited or deleted.
 */
export class FuelLogService {
  constructor(private readonly deps: FuelLogServiceDeps) {}

  async list(caller: Caller, query: FuelLogListQuery): Promise<{ items: FuelLogView[]; total: number }> {
    const { logs, refs } = this.deps;
    return logs.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      const visibility = await this.visibility(client, caller);

      // Public ids to internal ids: undefined when not filtered, null when not found. A filter naming
      // something unknown (or outside scope) matches nothing: an empty page, not an error.
      const [vehicle, driverId, trip] = await Promise.all([
        query.vehicle_id ? refs.vehicles.refInScope(client, query.vehicle_id, scope) : undefined,
        query.driver_id ? refs.drivers.findInScope(client, query.driver_id, scope) : undefined,
        query.trip_id ? refs.trips.find(client, caller.user, query.trip_id) : undefined,
      ]);
      if (vehicle === null || driverId === null || trip === null) return { items: [], total: 0 };

      const { rows, total } = await logs.list(client, {
        visibility,
        vehicleId: vehicle?.id,
        driverId,
        tripId: trip?.id,
        from: query.from,
        to: query.to,
        order: query.sort_order,
        page: query.page,
        page_size: query.page_size,
      });
      return { items: await this.views(client, rows), total };
    });
  }

  /** A log the caller may see; anyone else's, and a missing one, are the same 404. */
  async get(caller: Caller, fuelLogId: string): Promise<FuelLogView> {
    const { logs } = this.deps;
    return logs.inTransaction(async (client) => {
      const row = await logs.findVisible(client, fuelLogId, await this.visibility(client, caller));
      if (!row) throw fuelLogNotFound();
      return (await this.views(client, [row]))[0];
    });
  }

  async create(caller: Caller, input: FuelLogCreate): Promise<FuelLogView> {
    const { logs, refs } = this.deps;
    const scope = depotScope(caller.user);
    const own = ownDriverScope(caller.user);
    const now = Date.now();
    const fueledAt = input.fueled_at ?? new Date(now);
    if (fueledAt.getTime() > now + CLOCK_SKEW_MS) throw fueledInFuture();
    if (fueledAt.getTime() < now - MAX_FUELED_AGE_DAYS * 86_400_000) throw fueledTooOld();

    return logs.inTransaction(async (client) => {
      const vehicle = await refs.vehicles.lockInScope(client, input.vehicle_id, scope);
      if (!vehicle) throw fuelVehicleNotFound();
      if (!vehicle.isActive) throw fuelVehicleRetired();
      const fuelType = input.fuel_type ?? vehicle.fuelType;
      if (fuelType === 'electric') throw electricVehicle();

      const driverId = await this.driverFor(client, scope, own, input.driver_id);

      let tripId: string | null = null;
      if (input.trip_id) {
        const trip = await refs.trips.find(client, caller.user, input.trip_id);
        if (!trip) throw fuelTripNotFound();
        if (trip.vehicleId !== null && trip.vehicleId !== vehicle.id) throw tripVehicleMismatch();
        tripId = trip.id;
      }

      // The odometer only goes up with time: not below the vehicle's reading, nor below a fuel log from before
      // this fill-up; and a fill-up queued offline (FMS-115) not above one logged after it. The vehicle row is
      // locked, so two logs for it cannot both pass this against the same readings.
      const previous = await logs.lastOdometer(client, vehicle.id, fueledAt);
      const floor = Math.max(vehicle.odometerKm, previous ?? 0);
      if (input.odometer_km < floor) throw odometerRegression(floor);
      const next = await logs.nextOdometer(client, vehicle.id, fueledAt);
      if (next !== null && input.odometer_km > next) throw odometerAheadOfLater(next);

      const ctx = mutationContext(caller);
      const row = await logs.insert(
        ctx,
        {
          vehicle_id: vehicle.id,
          driver_id: driverId,
          trip_id: tripId,
          fuel_type: fuelType,
          quantity_ml: input.quantity_ml,
          unit_price_cents: input.unit_price_cents ?? null,
          total_cost_cents: input.total_cost_cents,
          odometer_km: input.odometer_km,
          station_name: input.station_name ?? null,
          source: 'manual',
          recorded_at: fueledAt,
        },
        client,
      );
      const view = (await this.views(client, [await logs.findById(client, row.id as string)]))[0];
      await this.deps.events.publish(client, [
        createEvent(
          FUEL_EVENTS.logged,
          {
            fuel_log_id: view.id,
            vehicle_id: view.vehicle_id,
            driver_id: view.driver_id,
            trip_id: view.trip_id,
            fuel_type: view.fuel_type,
            quantity_ml: view.quantity_ml,
            total_cost_cents: view.total_cost_cents,
            odometer_km: view.odometer_km,
            // The reading of the log before this one in time (null for a vehicle's first): consumption is the distance between the two.
            previous_odometer_km: previous,
            // When the fill-up happened (FMS-115); created_at is when it reached the server.
            recorded_at: view.recorded_at.toISOString(),
            created_at: view.created_at.toISOString(),
          },
          { actor: caller.user.publicId, correlationId: caller.correlationId },
          { aggregate: aggregateKey('vehicle', view.vehicle_id) },
        ),
      ]);
      return view;
    });
  }

  /** Who filled up: a driver is always themselves; staff may name a driver in their depots, or none. */
  private async driverFor(db: Queryable, scope: Scope, own: Scope, named: string | undefined): Promise<string | null> {
    const { refs } = this.deps;
    if (own.kind === 'own') {
      const mine = await refs.drivers.idOfUser(db, own.userId);
      if (!mine) throw noDriverProfile();
      if (named !== undefined && named !== (await refs.drivers.publicIds(db, [mine])).get(mine)) throw driverNotWritable();
      return mine;
    }
    if (own.kind === 'none') throw noDriverProfile();
    if (named === undefined) return null;
    const found = await refs.drivers.findInScope(db, named, scope);
    if (!found) throw fuelDriverNotFound();
    return found;
  }

  /** A driver (and nothing else): their own logs. Staff: the logs of their depots' vehicles. */
  private async visibility(db: Queryable, caller: Caller): Promise<FuelVisibility> {
    const own = ownDriverScope(caller.user);
    if (own.kind === 'own') {
      const driverId = await this.deps.refs.drivers.idOfUser(db, own.userId);
      return driverId ? { kind: 'driver', driverId } : { kind: 'none' };
    }
    if (own.kind === 'none') return { kind: 'none' };
    const vehicleIds = await this.deps.refs.vehicles.idsInScope(db, depotScope(caller.user));
    return vehicleIds === null ? { kind: 'all' } : { kind: 'vehicles', vehicleIds };
  }

  private async views(db: Queryable, rows: FuelLogRow[]): Promise<FuelLogView[]> {
    const { refs } = this.deps;
    const ids = (pick: (r: FuelLogRow) => string | null) => [...new Set(rows.flatMap((r) => (pick(r) ? [pick(r) as string] : [])))];
    const [vehicles, drivers, trips] = await Promise.all([
      refs.vehicles.publicIds(db, ids((r) => r.vehicleId)),
      refs.drivers.publicIds(db, ids((r) => r.driverId)),
      refs.trips.publicIds(db, ids((r) => r.tripId)),
    ]);
    return rows.map((r) => ({
      id: r.publicId,
      vehicle_id: vehicles.get(r.vehicleId) as string,
      driver_id: r.driverId ? (drivers.get(r.driverId) ?? null) : null,
      trip_id: r.tripId ? (trips.get(r.tripId) ?? null) : null,
      fuel_type: r.fuelType,
      quantity_ml: r.quantityMl,
      unit_price_cents: r.unitPriceCents,
      total_cost_cents: r.totalCostCents,
      odometer_km: r.odometerKm,
      station_name: r.stationName,
      source: r.source,
      recorded_at: r.recordedAt,
      created_at: r.createdAt,
    }));
  }
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
