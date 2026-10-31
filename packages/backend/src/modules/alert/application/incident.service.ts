import type { PoolClient } from 'pg';
import { depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { limitOffset, pageMeta, type Page } from '../../../shared/http/pagination';
import type { RequestUser } from '../../../types/express';
import type { AlertSeverity } from '../domain/alert';
import {
  CLOCK_SKEW_MS,
  CRITICAL,
  INCIDENT_EVENTS,
  INCIDENT_MANAGE_PERMISSION,
  INCIDENT_TRANSITIONS,
  MAX_REPORT_AGE_DAYS,
  RESOLVED_INCIDENT_STATUSES,
  incidentAssigneeNotFound,
  incidentClosed,
  incidentDriverNotFound,
  incidentDriverNotWritable,
  incidentInFuture,
  incidentNotFound,
  incidentNotesRequired,
  incidentTooOld,
  incidentTransitionNotAllowed,
  incidentTripNotFound,
  incidentTripVehicleMismatch,
  incidentVehicleNotFound,
  incidentVehicleRetired,
  type IncidentStatus,
  type IncidentType,
  type IncidentView,
} from '../domain/incident';
import type { IncidentChanges, IncidentRepository, IncidentRow, IncidentVisibility } from '../infrastructure/incident.repository';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

/** POST /incidents (api-contract §12.2). */
export interface IncidentCreate {
  description: string;
  severity: AlertSeverity;
  /** Defaults to `other`. */
  incident_type?: IncidentType;
  /** Public id of a live vehicle in the caller's depots. Optional: an incident away from a vehicle is still reported. */
  vehicle_id?: string;
  /** A trip the caller may see; if it has a vehicle it must be this one. */
  trip_id?: string;
  /** Staff may say which driver was involved (the trip's, by default); a driver is always themselves. */
  driver_id?: string;
  /** Both or neither (checked by the route). */
  latitude?: number;
  longitude?: number;
  /** When it happened: an offline queue may deliver it late. Defaults to now. */
  occurred_at?: Date;
}

/** PATCH /incidents/{id} (FMS-89): at least one field (checked by the route). */
export interface IncidentUpdate {
  status?: IncidentStatus;
  /** A user's public id, or null to unassign. */
  assigned_to?: string | null;
  /** What was found and done; null clears it. */
  notes?: string | null;
}

export interface IncidentQuery extends Page {
  status?: IncidentStatus[];
  severity?: AlertSeverity[];
  incident_type?: string[];
  vehicle_id?: string;
  from?: Date;
  to?: Date;
}

/** A submission's outcome: a new incident, or the one already on file (a late offline replay). */
export interface IncidentResult {
  incident: IncidentView;
  created: boolean;
}

/** What incident reporting needs from fleet, trip and auth (connected in alert/index.ts). */
export interface IncidentRefs {
  vehicles: {
    /** Row-locks the vehicle, so its maintenance flag is read and set by one report at a time. */
    lockInScope(
      client: PoolClient,
      publicId: string,
      scope: Scope,
    ): Promise<{ id: string; depotId: string | null; isActive: boolean; maintenanceFlag: boolean } | null>;
    idOf(db: Queryable, publicId: string): Promise<string | null>;
    setMaintenanceFlag(client: PoolClient, ctx: MutationContext, id: string, flag: boolean): Promise<unknown>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  drivers: {
    idOfUser(db: Queryable, userId: string): Promise<string | null>;
    findInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  depots: { publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> };
  trips: {
    find(db: Queryable, user: RequestUser, publicId: string): Promise<{ id: string; vehicleId: string | null; driverId: string | null } | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  users: {
    /** Public id and name of users by internal id. */
    accounts(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; fullName: string }>>;
    /** An active user holding the permission, by public id, with their home depot and whether they see every depot. */
    activeHolder(
      db: Queryable,
      publicId: string,
      permission: string,
    ): Promise<{ id: string; depotId: string | null; unscoped: boolean } | null>;
  };
}

export interface IncidentServiceDeps {
  incidents: IncidentRepository;
  refs: IncidentRefs;
  events: EventBus;
}

/**
 * Incident reports (FMS-38, §11 and §21): a driver reports what happened from wherever they are, through
 * the offline queue. Every incident publishes IncidentReported (the command center's live list); a critical
 * one also sets the vehicle's maintenance flag in the same transaction, and the alert engine turns it into
 * an alert. A driver reads only what they reported; staff read their depots' incidents.
 */
export class IncidentService {
  constructor(private readonly deps: IncidentServiceDeps) {}

  async create(caller: Caller, input: IncidentCreate): Promise<IncidentResult> {
    const { incidents, refs } = this.deps;
    const now = Date.now();
    const occurredAt = input.occurred_at ?? new Date(now);
    if (occurredAt.getTime() > now + CLOCK_SKEW_MS) throw incidentInFuture();
    if (occurredAt.getTime() < now - MAX_REPORT_AGE_DAYS * 86_400_000) throw incidentTooOld();
    const scope = depotScope(caller.user);
    // authorize() let a signed-in user through: a person, never a device token.
    const reporter = caller.user.id as string;

    return incidents.inTransaction(async (client) => {
      // One reporter's submissions one after the other: a late replay then finds its original.
      await incidents.lockReporter(client, reporter);
      if (input.occurred_at) {
        const original = await incidents.findReplay(client, reporter, occurredAt, input.description);
        if (original) return { incident: (await this.views(client, [original]))[0], created: false };
      }

      const vehicle = input.vehicle_id ? await refs.vehicles.lockInScope(client, input.vehicle_id, scope) : null;
      if (input.vehicle_id && !vehicle) throw incidentVehicleNotFound();
      if (vehicle && !vehicle.isActive) throw incidentVehicleRetired();

      const trip = input.trip_id ? await refs.trips.find(client, caller.user, input.trip_id) : null;
      if (input.trip_id && !trip) throw incidentTripNotFound();
      if (trip && vehicle && trip.vehicleId !== null && trip.vehicleId !== vehicle.id) throw incidentTripVehicleMismatch();

      const driverId = await this.driverFor(client, caller, scope, input.driver_id, trip?.driverId ?? null);
      const ctx: MutationContext = { userId: reporter, correlationId: caller.correlationId };
      const row = await incidents.insert(client, ctx, {
        incident_type: input.incident_type ?? 'other',
        severity: input.severity,
        description: input.description,
        vehicle_id: vehicle?.id ?? null,
        driver_id: driverId,
        trip_id: trip?.id ?? null,
        // The vehicle's depot, or the reporter's: whose dispatchers deal with it.
        depot_id: vehicle?.depotId ?? caller.user.depotId ?? null,
        reported_by: reporter,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        occurred_at: occurredAt,
      });
      const [view] = await this.views(client, [row]);

      // Critical: the vehicle is not to be driven until a technician has looked at it. Already flagged stays so.
      const flagSet = input.severity === CRITICAL && vehicle !== null && !vehicle.maintenanceFlag;
      if (flagSet) await refs.vehicles.setMaintenanceFlag(client, ctx, vehicle.id, true);

      await this.deps.events.publish(client, [
        createEvent(
          INCIDENT_EVENTS.reported,
          {
            incident_id: view.id,
            depot_id: view.depot_id,
            vehicle_id: view.vehicle_id,
            driver_id: view.driver_id,
            trip_id: view.trip_id,
            severity: view.severity,
            incident_type: view.incident_type,
            status: view.status,
            latitude: view.latitude,
            longitude: view.longitude,
            occurred_at: view.occurred_at.toISOString(),
            maintenance_flag_set: flagSet,
            // The reporter's own driver profile when a driver reported it: their socket is told too.
            reported_by_driver_id: ownDriverScope(caller.user).kind === 'own' ? view.driver_id : null,
          },
          { actor: caller.user.publicId, correlationId: caller.correlationId },
          { aggregate: aggregateKey('incident', view.id) },
        ),
      ]);
      return { incident: view, created: true };
    });
  }

  async list(caller: Caller, query: IncidentQuery): Promise<{ items: IncidentView[]; meta: ReturnType<typeof pageMeta> }> {
    const { incidents, refs } = this.deps;
    return incidents.inTransaction(async (client) => {
      // A vehicle named in the filter that does not exist matches nothing: an empty page, not an error.
      const vehicleId = query.vehicle_id ? await refs.vehicles.idOf(client, query.vehicle_id) : undefined;
      if (vehicleId === null) return { items: [], meta: pageMeta(query, 0) };
      const { rows, total } = await incidents.list(client, {
        visibility: visibilityOf(caller.user),
        vehicleId,
        statuses: query.status,
        severities: query.severity,
        types: query.incident_type,
        from: query.from,
        to: query.to,
        ...limitOffset(query),
      });
      return { items: await this.views(client, rows), meta: pageMeta(query, total) };
    });
  }

  /** An incident the caller may see; anyone else's, and a missing one, are the same 404. */
  async get(caller: Caller, incidentId: string): Promise<IncidentView> {
    const { incidents } = this.deps;
    return incidents.inTransaction(async (client) => {
      const row = await incidents.findVisible(client, incidentId, visibilityOf(caller.user));
      if (!row) throw incidentNotFound();
      return (await this.views(client, [row]))[0];
    });
  }

  /**
   * Handling an incident (FMS-89): its status (INCIDENT_TRANSITIONS), who deals with it, and notes, which resolving
   * or closing requires. Row-locked, so two consoles' changes apply one after the other. Each change is one audited
   * row and publishes IncidentUpdated; a request that changes nothing writes and publishes nothing.
   */
  async update(caller: Caller, incidentId: string, input: IncidentUpdate): Promise<IncidentView> {
    const { incidents, refs } = this.deps;
    return incidents.inTransaction(async (client) => {
      const row = await incidents.lockVisible(client, incidentId, visibilityOf(caller.user));
      if (!row) throw incidentNotFound();
      if (row.status === 'closed') throw incidentClosed();

      const status = input.status ?? row.status;
      if (status !== row.status && !INCIDENT_TRANSITIONS[row.status].includes(status)) throw incidentTransitionNotAllowed(row.status, status);
      const notes = input.notes === undefined ? row.notes : input.notes;
      const done = RESOLVED_INCIDENT_STATUSES.includes(status);
      if (done && !notes) throw incidentNotesRequired(status);

      let assignedTo = row.assignedTo;
      if (input.assigned_to === null) assignedTo = null;
      else if (input.assigned_to !== undefined) {
        const assignee = await refs.users.activeHolder(client, input.assigned_to, INCIDENT_MANAGE_PERMISSION);
        // Someone who sees every depot, or whose home depot is the incident's.
        if (!assignee || !(assignee.unscoped || (row.depotId !== null && assignee.depotId === row.depotId))) throw incidentAssigneeNotFound();
        assignedTo = assignee.id;
      }

      // authorize() let a signed-in user through: a person, never a device token.
      const actor = caller.user.id as string;
      const changes: IncidentChanges = {};
      if (status !== row.status) changes.status = status;
      if (assignedTo !== row.assignedTo) changes.assigned_to = assignedTo;
      if (notes !== row.notes) changes.notes = notes;
      if (done && !row.resolvedAt) Object.assign(changes, { resolved_at: new Date(), resolved_by: actor });
      if (!done && row.resolvedAt) Object.assign(changes, { resolved_at: null, resolved_by: null });
      if (Object.keys(changes).length === 0) return (await this.views(client, [row]))[0];

      const updated = await incidents.update(client, { userId: actor, correlationId: caller.correlationId }, row.id, changes);
      const [view] = await this.views(client, [updated]);
      // The driver who reported it is told too, as of its creation.
      const reporterDriver = updated.driverId && (await refs.drivers.idOfUser(client, updated.reportedBy)) === updated.driverId ? view.driver_id : null;
      await this.deps.events.publish(client, [
        createEvent(
          INCIDENT_EVENTS.updated,
          {
            incident_id: view.id,
            depot_id: view.depot_id,
            vehicle_id: view.vehicle_id,
            trip_id: view.trip_id,
            severity: view.severity,
            incident_type: view.incident_type,
            status: view.status,
            previous_status: row.status,
            assigned_to: view.assigned_to?.id ?? null,
            resolved_at: view.resolved_at?.toISOString() ?? null,
            updated_at: view.updated_at.toISOString(),
            changes: (['status', 'assigned_to', 'notes'] as const).filter((field) => field in changes),
            reported_by_driver_id: reporterDriver,
          },
          { actor: caller.user.publicId, correlationId: caller.correlationId },
          { aggregate: aggregateKey('incident', view.id) },
        ),
      ]);
      return view;
    });
  }

  /**
   * The active incidents (open, investigating) of one depot (internal id, already in the caller's scope) or of every
   * depot (null), most severe then newest, with how many there are by status and severity: the command center's (FMS-89).
   */
  async active(depotId: string | null, limit: number): Promise<{ items: IncidentView[]; counts: { status: IncidentStatus; severity: AlertSeverity; n: number }[] }> {
    const { incidents } = this.deps;
    return incidents.inTransaction(async (client) => {
      const rows = await incidents.active(client, depotId, limit);
      const counts = await incidents.activeCounts(client, depotId);
      return { items: await this.views(client, rows), counts };
    });
  }

  /** Who was involved: a driver is themselves (if they have a driver profile); staff may name a driver in their depots, else the trip's. */
  private async driverFor(db: Queryable, caller: Caller, scope: Scope, named: string | undefined, tripDriverId: string | null): Promise<string | null> {
    const { refs } = this.deps;
    const own = ownDriverScope(caller.user);
    if (own.kind === 'own') {
      const mine = await refs.drivers.idOfUser(db, own.userId);
      if (named !== undefined && (!mine || named !== (await refs.drivers.publicIds(db, [mine])).get(mine))) throw incidentDriverNotWritable();
      return mine;
    }
    if (named === undefined) return tripDriverId;
    const found = await refs.drivers.findInScope(db, named, scope);
    if (!found) throw incidentDriverNotFound();
    return found;
  }

  private async views(db: Queryable, rows: IncidentRow[]): Promise<IncidentView[]> {
    const { refs } = this.deps;
    const ids = (pick: (r: IncidentRow) => string | null) => [...new Set(rows.flatMap((r) => (pick(r) ? [pick(r) as string] : [])))];
    const [vehicles, drivers, trips, depots, users] = await Promise.all([
      refs.vehicles.publicIds(db, ids((r) => r.vehicleId)),
      refs.drivers.publicIds(db, ids((r) => r.driverId)),
      refs.trips.publicIds(db, ids((r) => r.tripId)),
      refs.depots.publicIds(db, ids((r) => r.depotId)),
      refs.users.accounts(db, [...new Set([...ids((r) => r.reportedBy), ...ids((r) => r.assignedTo), ...ids((r) => r.resolvedBy)])]),
    ]);
    const publicOf = (map: Map<string, string>, id: string | null) => (id ? (map.get(id) ?? null) : null);
    return rows.map((r) => ({
      id: r.publicId,
      incident_type: r.incidentType,
      severity: r.severity,
      status: r.status,
      description: r.description,
      vehicle_id: publicOf(vehicles, r.vehicleId),
      driver_id: publicOf(drivers, r.driverId),
      trip_id: publicOf(trips, r.tripId),
      depot_id: publicOf(depots, r.depotId),
      reported_by: users.get(r.reportedBy)?.publicId as string,
      latitude: r.latitude,
      longitude: r.longitude,
      occurred_at: r.occurredAt,
      created_at: r.createdAt,
      assigned_to: r.assignedTo && users.has(r.assignedTo) ? { id: users.get(r.assignedTo)!.publicId, full_name: users.get(r.assignedTo)!.fullName } : null,
      notes: r.notes,
      resolved_at: r.resolvedAt,
      resolved_by: r.resolvedBy ? (users.get(r.resolvedBy)?.publicId ?? null) : null,
      updated_at: r.updatedAt,
    }));
  }
}

/** A driver (and nothing else): what they reported. Staff: their depots' incidents. */
function visibilityOf(user: RequestUser): IncidentVisibility {
  const own = ownDriverScope(user);
  return own.kind === 'all' ? depotScope(user) : own;
}
