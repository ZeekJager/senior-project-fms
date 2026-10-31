import { depotScope } from '../../../shared/authz/scope';
import type { Page } from '../../../shared/http/pagination';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import {
  derivePeriods,
  downtimeNotFound,
  isUnplanned,
  openedByKind,
  type DowntimeFailure,
  type DowntimePeriodView,
  type DowntimeReason,
  type DowntimeRecord,
  type DowntimeSources,
} from '../domain/downtime';
import { vehicleNotFound } from '../domain/vehicle';
import type { DowntimeRepository, DowntimeSync, DowntimeVehicle, PeriodRow } from '../infrastructure/downtime.repository';
import type { VehicleRepository } from '../infrastructure/vehicle.repository';
import type { Caller } from './caller';

/** The maintenance module's records (those asked for, and those with a failure) and failures on these vehicles. */
export type DowntimeSourceLookup = (
  db: Queryable,
  vehicleIds: readonly string[],
  recordIds: readonly string[],
) => Promise<{ records: DowntimeRecord[]; failures: (DowntimeFailure & { vehicleId: string })[] }>;

export interface DowntimeServiceDeps {
  periods: DowntimeRepository;
  vehicles: Pick<VehicleRepository, 'findRef'>;
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string }[]> };
  /** Connected by src/modules/index.ts; without it a period knows only the status history. */
  sources: () => DowntimeSourceLookup | null;
  now?: () => Date;
}

/** How many vehicles one rebuild transaction re-derives. */
const REBUILD_BATCH = 200;

/**
 * Vehicle downtime (FMS-131, docs/downtime.md): fleet.downtime_periods, re-derived for a vehicle from its status
 * history and breakdowns whenever one of them changes (the fleet.downtime projection, on the change's
 * transaction), and for every vehicle by the rebuild. Both run `sync`, so they cannot disagree.
 */
export class DowntimeService {
  constructor(private readonly deps: DowntimeServiceDeps) {}

  /** The projection: a status change, failure or repair on this vehicle (public id) re-derives its periods. */
  async onVehicleEvent(tx: Queryable, vehiclePublicId: string): Promise<void> {
    const vehicle = await this.deps.periods.vehicleByPublicId(tx, vehiclePublicId);
    if (vehicle) await this.sync(tx, [vehicle]);
  }

  /** Re-derives every vehicle's periods, a batch per transaction, and says what had drifted. */
  async rebuild(): Promise<DowntimeSync & { vehicles: number }> {
    const total = { vehicles: 0, added: 0, repaired: 0, removed: 0 };
    let afterId = '0';
    for (;;) {
      const batch = await this.deps.periods.inTransaction(async (client) => {
        const vehicles = await this.deps.periods.vehiclesAfter(client, afterId, REBUILD_BATCH);
        const result = await this.sync(client, vehicles);
        return { vehicles, result };
      });
      if (batch.vehicles.length === 0) return total;
      total.vehicles += batch.vehicles.length;
      total.added += batch.result.added;
      total.repaired += batch.result.repaired;
      total.removed += batch.result.removed;
      afterId = batch.vehicles.at(-1)!.id;
    }
  }

  /** GET /vehicles/{id}/downtime: the vehicle's periods, newest first. Out of scope is 404. */
  async list(caller: Caller, vehiclePublicId: string, page: Page): Promise<{ items: DowntimePeriodView[]; total: number }> {
    const { periods, vehicles } = this.deps;
    return periods.inTransaction(async (client) => {
      const vehicle = await vehicles.findRef(client, { publicId: vehiclePublicId }, depotScope(caller.user));
      if (!vehicle) throw vehicleNotFound();
      const { items, total } = await periods.list(client, vehicle.id, page);
      return { items: await this.views(client, items), total };
    });
  }

  /**
   * PATCH /vehicles/{id}/downtime/{periodId}: a staff member's reason, with a note, kept through every rebuild;
   * `reason: null` goes back to the derived one. Audited.
   */
  async setReason(caller: Caller, vehiclePublicId: string, periodPublicId: string, input: { reason: DowntimeReason | null; note?: string | null }): Promise<DowntimePeriodView> {
    const { periods, vehicles } = this.deps;
    return periods.inTransaction(async (client) => {
      const vehicle = await vehicles.findRef(client, { publicId: vehiclePublicId }, depotScope(caller.user));
      if (!vehicle) throw vehicleNotFound();
      const period = await periods.find(client, vehicle.id, periodPublicId);
      if (!period) throw downtimeNotFound();
      await periods.setReason(client, { userId: caller.user.id, correlationId: caller.correlationId }, period.id, {
        reason: input.reason,
        note: input.note?.trim() || null,
        setBy: caller.user.id,
      });
      const [view] = await this.views(client, [(await periods.find(client, vehicle.id, periodPublicId))!]);
      return view;
    });
  }

  /** Re-derives and stores these vehicles' periods, each under its lock. */
  private async sync(db: Queryable, vehicles: readonly DowntimeVehicle[]): Promise<DowntimeSync> {
    const result = { added: 0, repaired: 0, removed: 0 };
    if (vehicles.length === 0) return result;
    const { periods } = this.deps;
    for (const v of vehicles) await periods.lock(db, v.id);
    const ids = vehicles.map((v) => v.id);
    const history = await periods.history(db, ids);
    const recordIds = [...new Set([...history.values()].flat().flatMap((c) => (c.maintenanceRecordId ? [c.maintenanceRecordId] : [])))];
    const found = (await this.deps.sources()?.(db, ids, recordIds)) ?? { records: [], failures: [] };
    const records = new Map(found.records.map((r) => [r.id, r]));
    for (const v of vehicles) {
      const sources: DowntimeSources = { records, failures: found.failures.filter((f) => f.vehicleId === v.id) };
      const changed = await periods.replace(db, v.id, derivePeriods(v, history.get(v.id) ?? [], sources));
      result.added += changed.added;
      result.repaired += changed.repaired;
      result.removed += changed.removed;
    }
    return result;
  }

  private async views(db: Queryable, rows: readonly PeriodRow[]): Promise<DowntimePeriodView[]> {
    const setBy = [...new Set(rows.flatMap((r) => (r.reasonSetBy ? [r.reasonSetBy] : [])))];
    const users = new Map((setBy.length ? await this.deps.users.findByIds(db, setBy) : []).map((u) => [u.id, u.publicId]));
    const now = (this.deps.now ?? (() => new Date()))();
    return rows.map((r) => ({
      id: r.publicId,
      vehicle_id: r.vehiclePublicId,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      duration_minutes: Math.round(((r.endedAt ?? now).getTime() - r.startedAt.getTime()) / 60_000),
      reason: r.reason,
      unplanned: isUnplanned(r.reason),
      derived_reason: r.derivedReason,
      reason_note: r.reasonNote,
      reason_set_by: r.reasonSetBy ? (users.get(r.reasonSetBy) ?? null) : null,
      reason_set_at: r.reasonSetAt,
      opened_by: openedByKind(r.openedBy),
      maintenance_record_id: r.maintenanceRecordId,
      failure_event_id: r.failureEventId,
    }));
  }
}
