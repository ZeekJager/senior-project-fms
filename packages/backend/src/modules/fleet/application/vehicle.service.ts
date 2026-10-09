import type { PoolClient } from 'pg';
import { depotScope } from '../../../shared/authz/scope';
import { createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { Caller } from './caller';
import {
  VEHICLE_EVENTS,
  depotNotFound,
  fuelEfficiencyRequired,
  odometerRegression,
  requiresFuelEfficiency,
  vehicleInUse,
  vehicleNotFound,
  vehicleRetired,
  type FuelType,
  type VehicleType,
  type VehicleView,
} from '../domain/vehicle';
import type { VehicleListQuery, VehicleRepository, VehicleWrite } from '../infrastructure/vehicle.repository';

export type { Caller } from './caller';

/** Fields of POST /vehicles, after validation and normalization. */
export interface VehicleCreate {
  registration_number: string;
  vin?: string | null;
  make: string;
  model: string;
  year?: number | null;
  vehicle_type: VehicleType;
  fuel_type: FuelType;
  fuel_efficiency_ml_per_km?: number | null;
  /** The depot's public id. */
  depot_id: string;
  odometer_km?: number;
}

/** Fields of PATCH /vehicles/{id}: any subset of the writable ones. */
export type VehicleUpdate = Partial<VehicleCreate>;

export interface VehicleServiceDeps {
  vehicles: Pick<
    VehicleRepository,
    'inTransaction' | 'findView' | 'findViewById' | 'list' | 'resolveDepot' | 'lockForWrite' | 'hasActiveAssignment' | 'insert' | 'update' | 'retire'
  >;
  /** The trip module's answer (through its index.ts): is the vehicle on an assigned or en-route trip? */
  trips: { vehicleHasActiveTrip(db: Queryable, vehicleId: string): Promise<boolean> };
  events: EventBus;
}

/**
 * Register, update and retire vehicles (FMS-15). Every write is limited to
 * the caller's depot scope, writes one audit row, and publishes its event
 * only after the transaction has committed.
 */
export class VehicleService {
  constructor(private readonly deps: VehicleServiceDeps) {}

  list(caller: Caller, query: VehicleListQuery): Promise<{ items: VehicleView[]; total: number }> {
    const { vehicles } = this.deps;
    return vehicles.inTransaction((client) => vehicles.list(client, query, depotScope(caller.user)));
  }

  async get(caller: Caller, vehicleId: string): Promise<VehicleView> {
    const { vehicles } = this.deps;
    const view = await vehicles.inTransaction((client) => vehicles.findView(client, vehicleId, depotScope(caller.user)));
    if (!view) throw vehicleNotFound();
    return view;
  }

  async create(caller: Caller, input: VehicleCreate): Promise<VehicleView> {
    const { vehicles } = this.deps;
    if (requiresFuelEfficiency(input.fuel_type) && input.fuel_efficiency_ml_per_km == null) throw fuelEfficiencyRequired();

    const view = await vehicles.inTransaction(async (client) => {
      const depotId = await this.depotInScope(client, input.depot_id, caller);
      const row = await vehicles.insert(mutationContext(caller), { ...toColumns(input), depot_id: depotId }, client);
      return vehicles.findViewById(client, row.id as string);
    });

    await this.publish(caller, VEHICLE_EVENTS.registered, { vehicle_id: view.id, depot_id: view.depot_id });
    return view;
  }

  /** `expectedVersion` (from If-Match): refuse with 409 CONFLICT_CONCURRENT_MODIFICATION if the vehicle has changed since. */
  async update(caller: Caller, vehicleId: string, patch: VehicleUpdate, expectedVersion: number | null = null): Promise<VehicleView> {
    const { vehicles } = this.deps;
    const view = await vehicles.inTransaction(async (client) => {
      const current = await vehicles.lockForWrite(client, vehicleId, depotScope(caller.user));
      if (!current) throw vehicleNotFound();
      if (expectedVersion !== null && expectedVersion !== current.version) throw staleVersion();
      if (!current.isActive) throw vehicleRetired();

      // The fuel-efficiency rule holds for the vehicle after the change, so a
      // PATCH that makes an electric vehicle diesel must also give an efficiency.
      const fuelType = patch.fuel_type ?? current.fuelType;
      const efficiency = 'fuel_efficiency_ml_per_km' in patch ? patch.fuel_efficiency_ml_per_km : current.fuelEfficiencyMlPerKm;
      if (requiresFuelEfficiency(fuelType) && efficiency == null) throw fuelEfficiencyRequired();

      // An odometer only goes up; a lower reading needs the correction workflow (api-contract §17).
      if (patch.odometer_km !== undefined && patch.odometer_km < current.odometerKm) throw odometerRegression();

      const data: VehicleWrite = toColumns(patch);
      if (patch.depot_id !== undefined) data.depot_id = await this.depotInScope(client, patch.depot_id, caller);

      await vehicles.update(mutationContext(caller), current.id, data, client);
      return vehicles.findViewById(client, current.id);
    });

    await this.publish(caller, VEHICLE_EVENTS.updated, {
      vehicle_id: view.id,
      depot_id: view.depot_id,
      changed_fields: Object.keys(patch).sort(),
    });
    return view;
  }

  /**
   * Soft-retires a vehicle (DELETE /vehicles/{id}). Blocked while the vehicle
   * is on an assigned or en-route trip or assigned to a driver. Retiring an
   * already retired vehicle changes nothing and succeeds, so a retried DELETE
   * is safe.
   *
   * The vehicle row stays locked until commit, so the check and the retirement
   * cannot interleave with a change to this vehicle. Trip assignment must lock
   * the vehicle row too (and refuse a retired vehicle), which closes the race
   * from that side.
   */
  async retire(caller: Caller, vehicleId: string): Promise<void> {
    const { vehicles, trips } = this.deps;
    const retired = await vehicles.inTransaction(async (client) => {
      const current = await vehicles.lockForWrite(client, vehicleId, depotScope(caller.user));
      if (!current) throw vehicleNotFound();
      if (!current.isActive) return null;

      if ((await trips.vehicleHasActiveTrip(client, current.id)) || (await vehicles.hasActiveAssignment(client, current.id))) {
        throw vehicleInUse();
      }
      await vehicles.retire(mutationContext(caller), current.id, client);
      return vehicles.findViewById(client, current.id);
    });

    if (retired) await this.publish(caller, VEHICLE_EVENTS.retired, { vehicle_id: retired.id, depot_id: retired.depot_id });
  }

  /** A depot the caller may put vehicles in, or 400: an unknown depot and one outside the scope look the same. */
  private async depotInScope(client: PoolClient, depotPublicId: string, caller: Caller): Promise<string> {
    const depotId = await this.deps.vehicles.resolveDepot(client, depotPublicId, depotScope(caller.user));
    if (!depotId) throw depotNotFound();
    return depotId;
  }

  private publish(caller: Caller, type: string, payload: Record<string, unknown>): Promise<void> {
    const event: DomainEvent = createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId });
    return this.deps.events.publish([event]);
  }
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

/** API field names to fleet.vehicles columns. `depot_id` is resolved separately (public id to internal id). */
function toColumns(input: VehicleUpdate): VehicleWrite {
  const data: VehicleWrite = {};
  if (input.registration_number !== undefined) data.registration_number = input.registration_number;
  if (input.vin !== undefined) data.vin = input.vin;
  if (input.make !== undefined) data.make = input.make;
  if (input.model !== undefined) data.model = input.model;
  if (input.year !== undefined) data.model_year = input.year;
  if (input.vehicle_type !== undefined) data.vehicle_type = input.vehicle_type;
  if (input.fuel_type !== undefined) data.fuel_type = input.fuel_type;
  if (input.fuel_efficiency_ml_per_km !== undefined) data.fuel_efficiency_ml_per_km = input.fuel_efficiency_ml_per_km;
  if (input.odometer_km !== undefined) data.odometer_km = input.odometer_km;
  return data;
}
