import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { AppError } from '../../../shared/errors/app-error';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { operatingToday, type AttendanceStatus } from '../domain/attendance';
import type { AvailabilityWindow } from '../domain/availability';
import { drivableTypes, driverBoardState, vehicleBoardState, type DispatchBoard, type OpenWorkSummary, type ServiceDueSummary } from '../domain/dispatch';
import type { availabilityStore } from '../infrastructure/availability.repository';
import type { AvailabilityService } from './availability.service';
import type { Caller } from './caller';

export interface DispatchServiceDeps {
  store: Pick<typeof availabilityStore, 'depotDrivers' | 'depotVehicles' | 'underWay'>;
  availability: Pick<AvailabilityService, 'check'>;
  attendance: { statusOn(db: Queryable, driverIds: readonly string[], date: string): Promise<Map<string, AttendanceStatus>> };
  depots: {
    /** A live depot by public id in the caller's scope (share-locked). */
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>>;
  };
  /** The maintenance module's open-work and service-due summaries, connected by src/modules/index.ts. */
  maintenance: () => {
    openRecordSummaries(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, OpenWorkSummary>>;
    serviceDueSummaries(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, ServiceDueSummary>>;
  } | null;
  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  now?: () => Date;
}

/** Someone who sees several depots (or none of their own) must say which. */
const depotRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Choose a depot.', [{ field: 'depot_id', reason: 'required' }]);

const depotNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The depot does not exist or is outside your depots.', [{ field: 'depot_id', reason: 'references_missing_record' }]);

/**
 * The dispatcher's board (FMS-33, S-07): a depot's drivers and vehicles, each
 * with its state now (the colour on the console) and its availability for
 * the trip being staffed. One read, one transaction, for a screen that polls.
 */
export class DispatchService {
  constructor(private readonly deps: DispatchServiceDeps) {}

  /**
   * GET /dispatch/availability. `depotId` (public) defaults to the caller's
   * own depot; someone who sees several must choose. `excludeTripId` is the
   * trip being staffed: its own assignment is not a conflict.
   */
  async board(caller: Caller, query: { depotId?: string; window?: AvailabilityWindow; excludeTripId?: string }): Promise<DispatchBoard> {
    const { store, availability } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const window = query.window ?? { start: now, end: now };
    return this.deps.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      let depotId: string | null;
      if (query.depotId) depotId = await this.deps.depots.resolveInScope(client, query.depotId, scope);
      else if (scope.kind === 'depot') depotId = scope.depotId;
      else throw depotRequired();
      if (!depotId) throw depotNotFound();

      const drivers = await store.depotDrivers(client, depotId);
      const vehicles = await store.depotVehicles(client, depotId);
      const answer = await availability.check(client, {
        driverIds: drivers.map((d) => d.id),
        vehicleIds: vehicles.map((v) => v.id),
        window,
        depotId,
        ...(query.excludeTripId ? { excludeTripId: query.excludeTripId } : {}),
      });
      const driversUnderWay = await store.underWay(client, 'driver_id', drivers.map((d) => d.id));
      const vehiclesUnderWay = await store.underWay(client, 'vehicle_id', vehicles.map((v) => v.id));
      const attendance = await this.deps.attendance.statusOn(client, drivers.map((d) => d.id), operatingToday(window.start));
      const flagged = vehicles.filter((v) => v.maintenanceFlag).map((v) => v.id);
      const openWork = flagged.length > 0 ? ((await this.deps.maintenance()?.openRecordSummaries(client, flagged)) ?? new Map()) : new Map<string, OpenWorkSummary>();
      const serviceDue = (await this.deps.maintenance()?.serviceDueSummaries(client, vehicles.map((v) => v.id))) ?? new Map<string, ServiceDueSummary>();
      const trip = (t: { tripId: string; end: Date } | undefined) => (t ? { trip_id: t.tripId, end: t.end } : null);

      return {
        depot_id: (await this.deps.depots.publicIds(client, [depotId])).get(depotId)!,
        window: { start: window.start, end: window.end },
        drivers: drivers.map((d) => {
          const result = answer.drivers.get(d.id)!;
          const underWay = driversUnderWay.get(d.id) ?? null;
          const marked = attendance.get(d.id) ?? null;
          return {
            driver_id: d.publicId,
            full_name: d.fullName,
            license_categories: d.licenseCategories,
            vehicle_types: drivableTypes(d.licenseCategories),
            state: driverBoardState({ underWay, attendance: marked, availability: result, now }),
            attendance: marked,
            availability: result,
            current_trip: trip(underWay ?? undefined),
          };
        }),
        vehicles: vehicles.map((v) => {
          const result = answer.vehicles.get(v.id)!;
          const underWay = vehiclesUnderWay.get(v.id) ?? null;
          return {
            vehicle_id: v.publicId,
            registration_number: v.registrationNumber,
            make: v.make,
            model: v.model,
            vehicle_type: v.vehicleType,
            status: v.status,
            state: vehicleBoardState({ status: v.status, maintenanceFlag: v.maintenanceFlag, underWay, availability: result }),
            availability: result,
            open_work: openWork.get(v.id) ?? null,
            service_due: serviceDue.get(v.id) ?? null,
            current_trip: trip(underWay ?? undefined),
          };
        }),
      };
    });
  }
}
