import { depotScope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Page } from '../../../shared/http/pagination';
import {
  ASSIGNMENT_EVENTS,
  assignmentAlreadyEnded,
  assignmentDateRange,
  assignmentDepotMismatch,
  assignmentDriverNotFound,
  assignmentDriverRetired,
  assignmentEndInFuture,
  assignmentNotFound,
  assignmentVehicleNotFound,
  assignmentVehicleRetired,
  driverHasPrimary,
  temporaryNeedsEnd,
  vehicleHasPrimary,
  type AssignmentType,
  type AssignmentView,
} from '../domain/assignment';
import { driverNotFound } from '../domain/driver';
import { vehicleNotFound } from '../domain/vehicle';
import type { AssignmentRepository } from '../infrastructure/assignment.repository';
import type { DriverRepository } from '../infrastructure/driver.repository';
import type { VehicleRepository } from '../infrastructure/vehicle.repository';
import type { Caller } from './caller';

export interface AssignmentCreate {
  driver_id: string;
  vehicle_id: string;
  assignment_type?: AssignmentType;
  start_at?: Date;
  end_at?: Date | null;
  notes?: string | null;
}

export interface AssignmentEnd {
  end_at?: Date;
  notes?: string;
}

export interface AssignmentServiceDeps {
  assignments: AssignmentRepository;
  vehicles: Pick<VehicleRepository, 'lockForWrite' | 'findRef'>;
  drivers: Pick<DriverRepository, 'findForTrip'>;
  events: EventBus;
  now?: () => Date;
}

const ctxOf = (caller: Caller): MutationContext => ({ userId: caller.user.id, correlationId: caller.correlationId });

/**
 * A driver's regular vehicle (FMS-77, docs/driver-vehicle-assignments.md): assignment:write gives one, ends one;
 * assignment:read lists a driver's or a vehicle's history. Both must be in the caller's depots, and in the same depot.
 */
export class AssignmentService {
  constructor(private readonly deps: AssignmentServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  async create(caller: Caller, input: AssignmentCreate): Promise<AssignmentView> {
    const { assignments, vehicles, events } = this.deps;
    const scope = depotScope(caller.user);
    const type = input.assignment_type ?? 'primary';
    const start = input.start_at ?? this.now();
    const end = input.end_at ?? null;
    if (type === 'temporary' && end === null) throw temporaryNeedsEnd();
    if (end !== null && end.getTime() <= start.getTime()) throw assignmentDateRange();

    return assignments.inTransaction(async (client) => {
      // Both locked, vehicle first as everywhere: two assignments for either are decided one after the other.
      const vehicle = await vehicles.lockForWrite(client, input.vehicle_id, scope);
      if (!vehicle) throw assignmentVehicleNotFound();
      const driver = await assignments.lockDriver(client, input.driver_id, scope);
      if (!driver) throw assignmentDriverNotFound();
      if (!vehicle.isActive || vehicle.status === 'retired') throw assignmentVehicleRetired();
      if (!driver.isActive) throw assignmentDriverRetired();
      if (driver.depotId !== vehicle.depotId) throw assignmentDepotMismatch();

      if (type === 'primary') {
        const driversPrimary = await assignments.overlappingPrimary(client, 'driver', driver.id, start, end);
        if (driversPrimary) throw driverHasPrimary(driversPrimary);
        const vehiclesPrimary = await assignments.overlappingPrimary(client, 'vehicle', vehicle.id, start, end);
        if (vehiclesPrimary) throw vehicleHasPrimary(vehiclesPrimary);
      }

      const id = await assignments.insert(client, ctxOf(caller), {
        driverId: driver.id,
        vehicleId: vehicle.id,
        assignmentType: type,
        assignedFrom: start,
        assignedUntil: end,
        notes: input.notes ?? null,
      });
      const view = (await assignments.view(client, id, { kind: 'all' }))!;
      await events.publish(client, [
        createEvent(
          ASSIGNMENT_EVENTS.assigned,
          {
            assignment_id: view.id,
            driver_id: view.driver.id,
            vehicle_id: view.vehicle.id,
            depot_id: view.depot_id,
            assignment_type: view.assignment_type,
            start_at: view.start_at.toISOString(),
            end_at: view.end_at ? view.end_at.toISOString() : null,
          },
          { actor: caller.user.publicId, correlationId: caller.correlationId },
          { aggregate: aggregateKey('vehicle', view.vehicle.id) },
        ),
      ]);
      return view;
    });
  }

  async end(caller: Caller, publicId: string, input: AssignmentEnd): Promise<AssignmentView> {
    const { assignments, events } = this.deps;
    const scope = depotScope(caller.user);
    const now = this.now();
    const endAt = input.end_at ?? now;
    if (endAt.getTime() > now.getTime() + 60_000) throw assignmentEndInFuture();

    return assignments.inTransaction(async (client) => {
      const row = await assignments.lockForWrite(client, publicId, scope);
      if (!row) throw assignmentNotFound();
      if (row.status !== 'active') throw assignmentAlreadyEnded(row.status);
      if (endAt.getTime() <= row.assignedFrom.getTime()) throw assignmentDateRange();
      await assignments.end(client, ctxOf(caller), row.id, endAt, input.notes);
      const view = (await assignments.view(client, publicId, { kind: 'all' }))!;
      await events.publish(client, [
        createEvent(
          ASSIGNMENT_EVENTS.ended,
          { assignment_id: view.id, driver_id: view.driver.id, vehicle_id: view.vehicle.id, depot_id: view.depot_id, end_at: endAt.toISOString() },
          { actor: caller.user.publicId, correlationId: caller.correlationId },
          { aggregate: aggregateKey('vehicle', view.vehicle.id) },
        ),
      ]);
      return view;
    });
  }

  async get(caller: Caller, publicId: string): Promise<AssignmentView> {
    const view = await this.deps.assignments.inTransaction((client) => this.deps.assignments.view(client, publicId, depotScope(caller.user)));
    if (!view) throw assignmentNotFound();
    return view;
  }

  /** GET /drivers/{id}/assignments: a driver in the caller's depots. */
  async forDriver(caller: Caller, driverPublicId: string, page: Page): Promise<{ items: AssignmentView[]; total: number }> {
    const { assignments, drivers } = this.deps;
    return assignments.inTransaction(async (client) => {
      const driver = await drivers.findForTrip(client, driverPublicId, depotScope(caller.user));
      if (!driver) throw driverNotFound();
      return assignments.history(client, 'driver', driver.id, page);
    });
  }

  /** GET /vehicles/{id}/assignments: a vehicle in the caller's depots (retired ones too: it is history). */
  async forVehicle(caller: Caller, vehiclePublicId: string, page: Page): Promise<{ items: AssignmentView[]; total: number }> {
    const { assignments, vehicles } = this.deps;
    return assignments.inTransaction(async (client) => {
      const vehicle = await vehicles.findRef(client, { publicId: vehiclePublicId }, depotScope(caller.user));
      if (!vehicle) throw vehicleNotFound();
      return assignments.history(client, 'vehicle', vehicle.id, page);
    });
  }
}
