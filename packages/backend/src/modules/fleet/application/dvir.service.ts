import { depotInScope, depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import type { UserAccount } from '../../auth';
import {
  CLOCK_SKEW_MS,
  DVIR_EVENTS,
  MAX_SUBMISSION_AGE_DAYS,
  dvirDriverNotFound,
  dvirDriverNotWritable,
  dvirDriverRequired,
  dvirNoDriverProfile,
  dvirSubmittedInFuture,
  dvirSubmittedTooOld,
  dvirTripNotFound,
  dvirTripVehicleMismatch,
  dvirVehicleNotFound,
  dvirVehicleRetired,
  type DvirDefect,
  type DvirItem,
  type DvirReportView,
  type DvirType,
} from '../domain/dvir';
import { vehicleNotFound } from '../domain/vehicle';
import type { DriverRepository } from '../infrastructure/driver.repository';
import type { DvirRepository, DvirRow } from '../infrastructure/dvir.repository';
import type { VehicleRepository } from '../infrastructure/vehicle.repository';
import type { Caller } from './caller';

/** POST /dvir-reports. */
export interface DvirCreate {
  /** Public id of a live vehicle in the caller's depots. */
  vehicle_id: string;
  /** A trip the caller may see; if it has a vehicle it must be this one. With it, a resubmission returns the original. */
  trip_id?: string;
  /** Staff say whose inspection it is; a driver is always themselves. */
  driver_id?: string;
  type: DvirType;
  items: DvirItem[];
  /** The driver's own answer. A failed item forces it true. */
  issues_found?: boolean;
  /** When the driver submitted it (an offline queue may be late). Defaults to now. */
  submitted_at?: Date;
}

export interface DvirListQuery {
  page: number;
  page_size: number;
  type?: DvirType;
  issues_found?: boolean;
  from?: Date;
  to?: Date;
  sort_order: 'asc' | 'desc';
}

/** What a submission did: a new report, or the one already on file. */
export interface DvirResult {
  report: DvirReportView;
  created: boolean;
}

export interface DvirServiceDeps {
  reports: Pick<DvirRepository, 'inTransaction' | 'list' | 'findById' | 'findFor' | 'insert'>;
  vehicles: Pick<VehicleRepository, 'lockForWrite' | 'findRef' | 'refsByIds' | 'setMaintenanceFlag'>;
  drivers: Pick<DriverRepository, 'findByUserId' | 'findByPublicId' | 'publicIdsByIds'>;
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<UserAccount[]> };
  /** The trip module's lookups (through its index.ts). */
  trips: {
    find(db: Queryable, user: RequestUser, publicId: string): Promise<{ id: string; vehicleId: string | null; driverId: string | null } | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  events: EventBus;
}

/**
 * Driver vehicle inspection reports (FMS-36, §6.4): a record of every pre-trip,
 * post-trip or routine inspection. A report that finds issues sets the
 * vehicle's maintenance flag in the same transaction and publishes
 * VehicleFaultDetected; the vehicle is not locked out, a technician reviews the
 * flag. A driver submits and reads only their own reports; staff see their
 * depots' vehicles'. A report is never edited or deleted.
 */
export class DvirService {
  constructor(private readonly deps: DvirServiceDeps) {}

  async create(caller: Caller, input: DvirCreate): Promise<DvirResult> {
    const { reports, vehicles, trips } = this.deps;
    const scope = depotScope(caller.user);
    const own = ownDriverScope(caller.user);
    const now = Date.now();
    const submittedAt = input.submitted_at ?? new Date(now);
    if (submittedAt.getTime() > now + CLOCK_SKEW_MS) throw dvirSubmittedInFuture();
    if (submittedAt.getTime() < now - MAX_SUBMISSION_AGE_DAYS * 86_400_000) throw dvirSubmittedTooOld();

    return reports.inTransaction(async (client) => {
      // Locked, so two submissions for one vehicle (a retry racing its original) are handled one after the other.
      const vehicle = await vehicles.lockForWrite(client, input.vehicle_id, scope);
      if (!vehicle) throw dvirVehicleNotFound();
      if (!vehicle.isActive) throw dvirVehicleRetired();

      let tripId: string | null = null;
      if (input.trip_id) {
        const trip = await trips.find(client, caller.user, input.trip_id);
        if (!trip) throw dvirTripNotFound();
        if (trip.vehicleId !== null && trip.vehicleId !== vehicle.id) throw dvirTripVehicleMismatch();
        tripId = trip.id;
        // The same inspection of the same trip, again (an offline replay): the original, nothing new.
        const existing = await reports.findFor(client, vehicle.id, tripId, input.type);
        if (existing) return { report: (await this.views(client, [existing]))[0], created: false };
      }

      const driverId = await this.driverFor(client, caller, own, input.driver_id);

      const defects: DvirDefect[] = input.items.filter((i) => !i.passed).map((i) => ({ name: i.name, notes: i.notes }));
      const issuesFound = input.issues_found === true || defects.length > 0;
      const ctx = mutationContext(caller);
      const row = await reports.insert(
        ctx,
        {
          vehicle_id: vehicle.id,
          driver_id: driverId,
          trip_id: tripId,
          inspection_type: input.type,
          checklist: JSON.stringify({ items: input.items }),
          defects: JSON.stringify(defects),
          issues_found: issuesFound,
          submitted_at: submittedAt,
        },
        client,
      );
      const view = (await this.views(client, [await reports.findById(client, row.id as string)]))[0];

      if (issuesFound) {
        // Flag it, in this transaction. A vehicle already flagged stays so: the new defects still raise the event.
        if (!vehicle.maintenanceFlag) await vehicles.setMaintenanceFlag(ctx, vehicle.id, true, client);
        await this.deps.events.publish(client, [
          createEvent(
            DVIR_EVENTS.faultDetected,
            {
              source: 'dvir',
              dvir_report_id: view.id,
              vehicle_id: view.vehicle_id,
              driver_id: view.driver_id,
              trip_id: view.trip_id,
              inspection_type: view.type,
              defect_count: defects.length,
              defects: defects.map((d) => d.name),
              maintenance_flag_set: !vehicle.maintenanceFlag,
            },
            { actor: caller.user.publicId, correlationId: caller.correlationId },
            { aggregate: aggregateKey('vehicle', view.vehicle_id) },
          ),
        ]);
      }
      return { report: view, created: true };
    });
  }

  /** GET /vehicles/{id}/dvir-reports: a driver sees their own reports of the vehicle; staff, every report of a vehicle in their depots. */
  async listForVehicle(caller: Caller, vehiclePublicId: string, query: DvirListQuery): Promise<{ items: DvirReportView[]; total: number }> {
    const { reports, vehicles, drivers } = this.deps;
    return reports.inTransaction(async (client) => {
      const vehicle = await vehicles.findRef(client, { publicId: vehiclePublicId }, depotScope(caller.user));
      if (!vehicle) throw vehicleNotFound();

      let driverId: string | undefined;
      const own = ownDriverScope(caller.user);
      if (own.kind === 'own') {
        const mine = await drivers.findByUserId(client, own.userId);
        if (!mine) return { items: [], total: 0 };
        driverId = mine.id;
      } else if (own.kind === 'none') {
        return { items: [], total: 0 };
      }

      const { rows, total } = await reports.list(client, {
        vehicleId: vehicle.id,
        driverId,
        type: query.type,
        issuesFound: query.issues_found,
        from: query.from,
        to: query.to,
        order: query.sort_order,
        page: query.page,
        page_size: query.page_size,
      });
      return { items: await this.views(client, rows), total };
    });
  }

  /** Whose inspection it is: a driver is always themselves; staff must name a driver in their depots. */
  private async driverFor(db: Queryable, caller: Caller, own: Scope, named: string | undefined): Promise<string> {
    const { drivers, users } = this.deps;
    if (own.kind === 'own') {
      const mine = await drivers.findByUserId(db, own.userId);
      if (!mine) throw dvirNoDriverProfile();
      if (named !== undefined && named !== mine.publicId) throw dvirDriverNotWritable();
      return mine.id;
    }
    if (own.kind === 'none') throw dvirNoDriverProfile();
    if (named === undefined) throw dvirDriverRequired();
    const row = await drivers.findByPublicId(db, named);
    const [account] = row ? await users.findByIds(db, [row.userId]) : [];
    if (!row || !account || !depotInScope(depotScope(caller.user), account.depotId)) throw dvirDriverNotFound();
    return row.id;
  }

  private async views(db: Queryable, rows: DvirRow[]): Promise<DvirReportView[]> {
    const { vehicles, drivers, trips } = this.deps;
    const ids = (pick: (r: DvirRow) => string | null) => [...new Set(rows.flatMap((r) => (pick(r) ? [pick(r) as string] : [])))];
    const [vehicleRefs, driverIds, tripIds] = await Promise.all([
      vehicles.refsByIds(db, ids((r) => r.vehicleId)),
      drivers.publicIdsByIds(db, ids((r) => r.driverId)),
      trips.publicIds(db, ids((r) => r.tripId)),
    ]);
    return rows.map((r) => ({
      id: r.publicId,
      vehicle_id: vehicleRefs.get(r.vehicleId)?.publicId as string,
      driver_id: driverIds.get(r.driverId) as string,
      trip_id: r.tripId ? (tripIds.get(r.tripId) ?? null) : null,
      type: r.inspectionType,
      status: r.status,
      items: r.checklist.items ?? [],
      defects: r.defects,
      issues_found: r.issuesFound,
      submitted_at: r.submittedAt,
      created_at: r.createdAt,
    }));
  }
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
