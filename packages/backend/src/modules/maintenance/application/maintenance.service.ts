import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import {
  MAINTENANCE_EVENTS,
  OPEN_STATUSES,
  completedBeforeStart,
  completedInFuture,
  maintenanceClosed,
  maintenanceNotFound,
  maintenanceVehicleMissing,
  maintenanceVehicleNotFound,
  maintenanceVehicleRetired,
  partInOtherDepot,
  partNotFound,
  type MaintenancePriority,
  type MaintenanceRecordView,
  type MaintenanceStatus,
  type MaintenanceType,
  type MaintenanceWarning,
  type ServiceItemView,
} from '../domain/maintenance';
import { SERVICE_ITEMS } from '../domain/inventory';
import {
  FAILURE_EVENTS,
  failureIncidentNotFound,
  failureIncidentOtherVehicle,
  failureInFuture,
  failureOnCancelled,
  failureRequired,
  type FailureComponent,
  type FailureEventView,
  type FailureInput,
} from '../domain/failure';
import { INVENTORY_EVENTS } from '../domain/inventory';
import { inventoryEvent } from './inventory.service';
import type { FailureRepository, FailureRow } from '../infrastructure/failure.repository';
import type { LockedPart, MaintenanceRepository, RecordRow, RecordWrite } from '../infrastructure/maintenance.repository';

/** Who is asking, for scope, audit and events. */
export interface Caller {
  user: RequestUser;
  correlationId: string;
}

/** A vehicle as the fleet module describes it to maintenance (through fleet's index.ts). */
interface MaintenanceVehicle {
  id: string;
  publicId: string;
  registrationNumber: string;
  depotId: string;
  isActive: boolean;
  maintenanceFlag: boolean;
}

export interface PartUse {
  part_id: string;
  quantity: number;
  unit_cost_cents: number;
}

export interface MaintenanceCreate {
  vehicle_id: string;
  description: string;
  labour_hours: number;
  total_cost_cents: number;
  parts?: PartUse[];
  maintenance_type?: MaintenanceType;
  status?: 'scheduled' | 'open' | 'in_progress';
  priority?: MaintenancePriority;
  scheduled_at?: string | null;
  odometer_km?: number | null;
  workshop?: string | null;
  notes?: string | null;
  /** What failed (FMS-125), recorded with the repair. */
  failures?: FailureInput[];
}

export interface MaintenanceUpdate {
  description?: string;
  labour_hours?: number;
  total_cost_cents?: number;
  maintenance_type?: MaintenanceType;
  status?: MaintenanceStatus;
  priority?: MaintenancePriority;
  scheduled_at?: string | null;
  odometer_km?: number | null;
  workshop?: string | null;
  notes?: string | null;
  completed_at?: string;
  /** What failed (FMS-125), recorded before the completion is checked: POST .../complete only. */
  failures?: FailureInput[];
}

export interface MaintenanceListQuery {
  page: number;
  page_size: number;
  vehicle_id?: string;
  status?: MaintenanceStatus;
  open?: boolean;
  maintenance_type?: MaintenanceType;
  sort_order: 'asc' | 'desc';
}

export interface FailureListQuery {
  page: number;
  page_size: number;
  vehicle_id?: string;
  component?: FailureComponent;
  unplanned?: boolean;
  from?: Date;
  to?: Date;
}

export interface MaintenanceServiceDeps {
  records: Pick<
    MaintenanceRepository,
    | 'inTransaction'
    | 'list'
    | 'findByPublicId'
    | 'findById'
    | 'lockForWrite'
    | 'partLines'
    | 'hasOtherOpen'
    | 'hasInProgress'
    | 'lockParts'
    | 'insertRecord'
    | 'updateRecord'
    | 'consumePart'
    | 'lastServiceItems'
  >;
  vehicles: {
    findInScope(db: Queryable, by: { publicId: string } | { id: string }, scope: Scope, lock?: boolean): Promise<MaintenanceVehicle | null>;
    refsByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; registrationNumber: string }>>;
    idsInScope(db: Queryable, scope: Scope): Promise<string[] | null>;
    setMaintenanceFlag(client: PoolClient, ctx: MutationContext, id: string, flag: boolean): Promise<unknown>;
    /** Moves the vehicle's status with its workshop work (FMS-76): `inWorkshop` is whether any work on it is in progress now. */
    followWorkshop(client: PoolClient, caller: Caller, vehicleId: string, inWorkshop: boolean, recordId: string): Promise<unknown>;
  };
  failures: Pick<FailureRepository, 'insert' | 'forRecords' | 'countForRecord' | 'list'>;
  /** The incident a failure came from (alert module, FMS-38). */
  incidents: {
    find(db: Queryable, publicId: string): Promise<{ id: string; vehicleId: string | null } | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string }[]> };
  depots: { publicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>> };
  events: EventBus;
  now?: () => Date;
}

/** A completion a few minutes "in the future" is clock skew between devices, not a mistake. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Maintenance records (FMS-22): every repair on every vehicle, permanently and
 * audited. Opening work flags the vehicle for maintenance in the same
 * transaction; finishing the last open work on it clears the flag in the
 * same transaction. Work in progress puts the vehicle in the workshop
 * (status `maintenance`), and the last of it ending takes it out (FMS-76). Parts used come off the shelf; using more than the
 * stock record holds is recorded in full, stock stops at zero, and the
 * shortfall comes back as a LOW_STOCK warning, never a refusal.
 */
export class MaintenanceService {
  constructor(private readonly deps: MaintenanceServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async list(caller: Caller, query: MaintenanceListQuery): Promise<{ items: MaintenanceRecordView[]; total: number }> {
    const { records, vehicles } = this.deps;
    return records.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      let vehicleId: string | undefined;
      if (query.vehicle_id) {
        const vehicle = await vehicles.findInScope(client, { publicId: query.vehicle_id }, scope);
        if (!vehicle) return { items: [], total: 0 };
        vehicleId = vehicle.id;
      }
      const { rows, total } = await records.list(client, {
        page: query.page,
        page_size: query.page_size,
        vehicleIds: vehicleId ? null : await vehicles.idsInScope(client, scope),
        vehicleId,
        status: query.status,
        open: query.open,
        maintenanceType: query.maintenance_type,
        sortOrder: query.sort_order,
      });
      return { items: await this.views(client, rows), total };
    });
  }

  async get(caller: Caller, recordId: string): Promise<MaintenanceRecordView> {
    const { records } = this.deps;
    return records.inTransaction(async (client) => {
      const row = await records.findByPublicId(client, recordId);
      if (!row || !(await this.deps.vehicles.findInScope(client, { id: row.vehicleId }, depotScope(caller.user)))) throw maintenanceNotFound();
      return (await this.views(client, [row]))[0];
    });
  }

  /**
   * POST /maintenance. One transaction: the record, each part's line, stock
   * and ledger entry, and the vehicle's maintenance flag. The vehicle row is
   * locked, so a completion of other work on it cannot clear the flag at the
   * same moment.
   */
  async create(caller: Caller, input: MaintenanceCreate): Promise<{ record: MaintenanceRecordView; warnings: MaintenanceWarning[] }> {
    const { records, vehicles } = this.deps;
    const ctx = mutationContext(caller);
    const result = await records.inTransaction(async (client) => {
      const vehicle = await vehicles.findInScope(client, { publicId: input.vehicle_id }, depotScope(caller.user), true);
      if (!vehicle) throw maintenanceVehicleNotFound();
      if (!vehicle.isActive) throw maintenanceVehicleRetired();

      const uses = input.parts ?? [];
      const locked = new Map((await records.lockParts(client, uses.map((u) => u.part_id))).map((p) => [p.publicId, p]));
      uses.forEach((use, i) => {
        const part = locked.get(use.part_id);
        if (!part || !part.isActive) throw partNotFound(i);
        if (part.depotId !== null && part.depotId !== vehicle.depotId) throw partInOtherDepot(i);
      });

      const status = input.status ?? 'open';
      const row = await records.insertRecord(
        ctx,
        {
          vehicle_id: vehicle.id,
          maintenance_type: input.maintenance_type ?? 'corrective',
          description: input.description,
          status,
          priority: input.priority ?? 'normal',
          scheduled_at: input.scheduled_at ?? null,
          started_at: status === 'in_progress' ? this.now().toISOString() : null,
          odometer_km: input.odometer_km ?? null,
          labor_hours: input.labour_hours,
          total_cost_cents: input.total_cost_cents,
          workshop: input.workshop ?? null,
          notes: input.notes ?? null,
        },
        client,
      );

      const warnings: MaintenanceWarning[] = [];
      const reorder: LockedPart[] = [];
      for (const use of uses) {
        const part = locked.get(use.part_id)!;
        const before = part.stockQuantity;
        const { stock, shortfall } = await records.consumePart(ctx, client, {
          recordId: row.id as string,
          part,
          quantity: use.quantity,
          unitCostCents: use.unit_cost_cents,
          vehicleDepotId: vehicle.depotId,
          performedBy: caller.user.id,
        });
        part.stockQuantity = stock;
        if (before > part.reorderThreshold && stock <= part.reorderThreshold) reorder.push({ ...part });
        if (shortfall > 0) {
          warnings.push({ warning: 'LOW_STOCK', part_id: part.publicId, part_number: part.partNumber, stock_quantity: stock, shortfall });
        }
      }

      const inserted = await records.findById(client, row.id as string);
      const failed = await this.writeFailures(client, caller, vehicle, inserted, input.failures ?? [], 'failures');
      if (!vehicle.maintenanceFlag) await vehicles.setMaintenanceFlag(client, ctx, vehicle.id, true);
      const record = (await this.views(client, [inserted]))[0];
      if (status === 'in_progress') await vehicles.followWorkshop(client, caller, vehicle.id, true, record.id);
      if (record.total_cost_cents < record.parts_cost_cents) {
        warnings.push({ warning: 'COST_BELOW_PARTS', total_cost_cents: record.total_cost_cents, parts_cost_cents: record.parts_cost_cents });
      }
      const depotIds = await this.deps.depots.publicIds(client, [...new Set(reorder.flatMap((p) => (p.depotId ? [p.depotId] : [])))]);
      await this.deps.events.publish(client, [
        this.event(caller, MAINTENANCE_EVENTS.opened, { maintenance_record_id: record.id, vehicle_id: record.vehicle_id }),
        ...failed,
        // Same event as a manual adjustment that crosses the reorder point (FMS-23).
        ...reorder.map((p) =>
          inventoryEvent(caller, INVENTORY_EVENTS.reorderNeeded, {
            part_id: p.publicId,
            part_number: p.partNumber,
            depot_id: p.depotId ? (depotIds.get(p.depotId) ?? null) : null,
            stock_quantity: p.stockQuantity,
            reorder_threshold: p.reorderThreshold,
          }),
        ),
      ]);
      return { record, warnings };
    });
    return { record: result.record, warnings: result.warnings };
  }

  /**
   * PUT / PATCH /maintenance/{id}: changes the fields sent. `completed_at`
   * (or status `completed`) completes the work and `cancelled` closes it;
   * either clears the vehicle's maintenance flag in the same transaction when
   * no other work on it is still open. A closed record cannot change again.
   */
  async update(caller: Caller, recordId: string, patch: MaintenanceUpdate, expectedVersion: number | null = null): Promise<MaintenanceRecordView> {
    const { records, vehicles } = this.deps;
    const ctx = mutationContext(caller);
    return records.inTransaction(async (client) => {
      const row = await records.lockForWrite(client, recordId);
      const vehicle = row && (await vehicles.findInScope(client, { id: row.vehicleId }, depotScope(caller.user), true));
      if (!row || !vehicle) throw maintenanceNotFound();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      if (!OPEN_STATUSES.includes(row.status)) throw maintenanceClosed(row.status);

      const data = toColumns(patch);
      const now = this.now();
      const failed = await this.writeFailures(client, caller, vehicle, row, patch.failures ?? [], 'failures');
      if (patch.completed_at !== undefined || patch.status === 'completed') {
        const completedAt = patch.completed_at ? new Date(patch.completed_at) : now;
        if (completedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) throw completedInFuture();
        if (row.startedAt && completedAt < row.startedAt) throw completedBeforeStart();
        // The repair says what was done; its failures say what broke (FMS-125): the model's labels.
        if ((patch.maintenance_type ?? row.maintenanceType) === 'corrective' && (await this.deps.failures.countForRecord(client, row.id)) === 0) {
          throw failureRequired();
        }
        data.status = 'completed';
        data.completed_at = completedAt.toISOString();
        data.completed_by = caller.user.id;
      } else if (patch.status === 'in_progress' && !row.startedAt) {
        data.started_at = now.toISOString();
      }
      if (Object.keys(data).length > 0) await records.updateRecord(ctx, row.id, data, client);

      const isClosing = data.status === 'completed' || data.status === 'cancelled';
      let cleared = false;
      if (isClosing && vehicle.maintenanceFlag && !(await records.hasOtherOpen(client, row.vehicleId, row.id))) {
        await vehicles.setMaintenanceFlag(client, ctx, row.vehicleId, false);
        cleared = true;
      }
      const view = (await this.views(client, [await records.findById(client, row.id)]))[0];
      if (data.status !== undefined && data.status !== row.status && (data.status === 'in_progress' || row.status === 'in_progress')) {
        await vehicles.followWorkshop(client, caller, row.vehicleId, await records.hasInProgress(client, row.vehicleId), view.id);
      }
      const event =
        data.status === 'completed'
          ? this.event(caller, MAINTENANCE_EVENTS.completed, { maintenance_record_id: view.id, vehicle_id: view.vehicle_id, maintenance_flag_cleared: cleared })
          : this.event(caller, MAINTENANCE_EVENTS.updated, {
              maintenance_record_id: view.id,
              vehicle_id: view.vehicle_id,
              changed_fields: Object.keys(patch).sort(),
              maintenance_flag_cleared: cleared,
            });
      await this.deps.events.publish(client, [...failed, event]);
      return view;
    });
  }

  /**
   * POST /maintenance-records/{id}/failures: one failure the repair found.
   * Open or completed work (a failure can be added to a finished repair
   * later), never cancelled work. The record row is locked, so a completion
   * cannot check for failures while one is being added.
   */
  async recordFailure(caller: Caller, recordId: string, input: FailureInput): Promise<FailureEventView> {
    const { records, vehicles } = this.deps;
    return records.inTransaction(async (client) => {
      const row = await records.lockForWrite(client, recordId);
      const vehicle = row && (await vehicles.findInScope(client, { id: row.vehicleId }, depotScope(caller.user)));
      if (!row || !vehicle) throw maintenanceNotFound();
      if (row.status === 'cancelled') throw failureOnCancelled();
      const [event] = await this.writeFailures(client, caller, vehicle, row, [input], null);
      await this.deps.events.publish(client, [event]);
      const failure = (await this.deps.failures.forRecords(client, [row.id])).find((f) => f.publicId === event.payload.failure_event_id)!;
      return (await this.failureViews(client, [failure]))[0];
    });
  }

  /**
   * GET /vehicles/{id}/service-items (FMS-52): when each wearing part and
   * fluid was last changed, from the completed repairs that used a part
   * renewing it. Every item is listed; one never changed has nulls.
   */
  async serviceItems(caller: Caller, vehiclePublicId: string): Promise<ServiceItemView[]> {
    const { records, vehicles } = this.deps;
    return records.inTransaction(async (client) => {
      const vehicle = await vehicles.findInScope(client, { publicId: vehiclePublicId }, depotScope(caller.user));
      if (!vehicle) throw maintenanceVehicleMissing();
      const last = new Map((await records.lastServiceItems(client, vehicle.id)).map((r) => [r.item, r]));
      return SERVICE_ITEMS.map((item) => {
        const row = last.get(item);
        return {
          service_item: item,
          last_changed_at: row?.changedAt ?? null,
          maintenance_record_id: row?.recordPublicId ?? null,
          odometer_km: row?.odometerKm ?? null,
          part_number: row?.partNumber ?? null,
        };
      });
    });
  }

  /** GET /failure-events: newest first, in the caller's depots. */
  async listFailures(caller: Caller, query: FailureListQuery): Promise<{ items: FailureEventView[]; total: number }> {
    const { records, vehicles } = this.deps;
    return records.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      let vehicleId: string | undefined;
      if (query.vehicle_id) {
        const vehicle = await vehicles.findInScope(client, { publicId: query.vehicle_id }, scope);
        if (!vehicle) return { items: [], total: 0 };
        vehicleId = vehicle.id;
      }
      const { rows, total } = await this.deps.failures.list(client, {
        page: query.page,
        page_size: query.page_size,
        vehicleIds: vehicleId ? null : await vehicles.idsInScope(client, scope),
        vehicleId,
        component: query.component,
        unplanned: query.unplanned,
        from: query.from,
        to: query.to,
      });
      return { items: await this.failureViews(client, rows), total };
    });
  }

  /**
   * Records each failure on the repair and returns a FailureRecorded for
   * each, to publish on the same transaction. When it failed defaults to the
   * repair's opening, and the odometer to the repair's.
   */
  private async writeFailures(
    client: PoolClient,
    caller: Caller,
    vehicle: MaintenanceVehicle,
    record: RecordRow,
    inputs: readonly FailureInput[],
    field: string | null,
  ): Promise<DomainEvent[]> {
    const ctx = mutationContext(caller);
    const latest = this.now().getTime() + CLOCK_SKEW_MS;
    const events: DomainEvent[] = [];
    for (const [i, input] of inputs.entries()) {
      const at = (name: string) => (field === null ? name : `${field}.${i}.${name}`);
      const occurredAt = input.occurred_at ? new Date(input.occurred_at) : record.createdAt;
      if (occurredAt.getTime() > latest) throw failureInFuture(at('occurred_at'));
      let incidentId: string | null = null;
      if (input.incident_id) {
        const incident = await this.deps.incidents.find(client, input.incident_id);
        if (!incident) throw failureIncidentNotFound(at('incident_id'));
        if (incident.vehicleId !== vehicle.id) throw failureIncidentOtherVehicle(at('incident_id'));
        incidentId = incident.id;
      }
      const failure = await this.deps.failures.insert(client, ctx, {
        vehicle_id: vehicle.id,
        maintenance_record_id: record.id,
        incident_report_id: incidentId,
        component: input.component,
        failure_mode: input.failure_mode,
        unplanned: input.unplanned,
        detected_by: input.detected_by ?? 'technician',
        occurred_at: occurredAt.toISOString(),
        odometer_km: input.odometer_km === undefined ? record.odometerKm : input.odometer_km,
        notes: input.notes ?? null,
        recorded_by: caller.user.id,
      });
      events.push(
        createEvent(
          FAILURE_EVENTS.recorded,
          {
            failure_event_id: failure.publicId,
            vehicle_id: vehicle.publicId,
            maintenance_record_id: record.publicId,
            incident_id: input.incident_id ?? null,
            component: failure.component,
            failure_mode: failure.failureMode,
            unplanned: failure.unplanned,
            detected_by: failure.detectedBy,
            occurred_at: failure.occurredAt.toISOString(),
            odometer_km: failure.odometerKm,
          },
          { actor: caller.user.publicId, correlationId: caller.correlationId },
          // In order with the vehicle's other events: its failure history reads as it was recorded.
          { aggregate: aggregateKey('vehicle', vehicle.publicId) },
        ),
      );
    }
    return events;
  }

  private async failureViews(db: Queryable, rows: readonly FailureRow[]): Promise<FailureEventView[]> {
    if (rows.length === 0) return [];
    const vehicles = await this.deps.vehicles.refsByIds(db, [...new Set(rows.map((r) => r.vehicleId))]);
    const incidents = await this.deps.incidents.publicIds(db, [...new Set(rows.flatMap((r) => (r.incidentId ? [r.incidentId] : [])))]);
    const recorders = await this.deps.users.findByIds(db, [...new Set(rows.flatMap((r) => (r.recordedBy ? [r.recordedBy] : [])))]);
    const recorderIds = new Map(recorders.map((u) => [u.id, u.publicId]));
    return rows.map((r) => {
      const vehicle = vehicles.get(r.vehicleId)!;
      return {
        id: r.publicId,
        vehicle_id: vehicle.publicId,
        registration_number: vehicle.registrationNumber,
        maintenance_record_id: r.recordPublicId,
        incident_id: r.incidentId ? (incidents.get(r.incidentId) ?? null) : null,
        component: r.component,
        failure_mode: r.failureMode,
        unplanned: r.unplanned,
        detected_by: r.detectedBy,
        occurred_at: r.occurredAt,
        odometer_km: r.odometerKm,
        notes: r.notes,
        recorded_by: r.recordedBy ? (recorderIds.get(r.recordedBy) ?? null) : null,
        created_at: r.createdAt,
      };
    });
  }

  private async views(db: Queryable, rows: RecordRow[]): Promise<MaintenanceRecordView[]> {
    if (rows.length === 0) return [];
    const lines = await this.deps.records.partLines(db, rows.map((r) => r.id));
    const failureRows = await this.deps.failures.forRecords(db, rows.map((r) => r.id));
    const failureViews = await this.failureViews(db, failureRows);
    const vehicles = await this.deps.vehicles.refsByIds(db, [...new Set(rows.map((r) => r.vehicleId))]);
    const finishers = await this.deps.users.findByIds(db, [...new Set(rows.flatMap((r) => (r.completedBy ? [r.completedBy] : [])))]);
    const finisherIds = new Map(finishers.map((u) => [u.id, u.publicId]));
    return rows.map((r) => {
      const parts = lines
        .filter((l) => l.recordId === r.id)
        .map((l) => ({
          part_id: l.partPublicId,
          part_number: l.partNumber,
          name: l.name,
          quantity: l.quantity,
          unit_cost_cents: l.unitCostCents,
          line_cost_cents: l.quantity * l.unitCostCents,
        }));
      const vehicle = vehicles.get(r.vehicleId)!;
      return {
        id: r.publicId,
        vehicle_id: vehicle.publicId,
        registration_number: vehicle.registrationNumber,
        maintenance_type: r.maintenanceType,
        description: r.description,
        status: r.status,
        priority: r.priority,
        scheduled_at: r.scheduledAt,
        started_at: r.startedAt,
        completed_at: r.completedAt,
        odometer_km: r.odometerKm,
        labour_hours: r.labourHours,
        total_cost_cents: r.totalCostCents,
        parts_cost_cents: parts.reduce((sum, p) => sum + p.line_cost_cents, 0),
        workshop: r.workshop,
        notes: r.notes,
        completed_by: r.completedBy ? (finisherIds.get(r.completedBy) ?? null) : null,
        parts,
        failures: failureViews.filter((_, i) => failureRows[i].recordId === r.id),
        version: r.version,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      };
    });
  }

  /** A maintenance event, ordered per record in the outbox (FMS-73). */
  private event(caller: Caller, type: string, payload: { maintenance_record_id: string } & Record<string, unknown>): DomainEvent {
    const ctx = { actor: caller.user.publicId, correlationId: caller.correlationId };
    return createEvent(type, payload, ctx, { aggregate: aggregateKey('maintenance', payload.maintenance_record_id) });
  }
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

function toColumns(patch: MaintenanceUpdate): RecordWrite {
  const data: RecordWrite = {};
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.labour_hours !== undefined) data.labor_hours = patch.labour_hours;
  if (patch.total_cost_cents !== undefined) data.total_cost_cents = patch.total_cost_cents;
  if (patch.maintenance_type !== undefined) data.maintenance_type = patch.maintenance_type;
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.priority !== undefined) data.priority = patch.priority;
  if (patch.scheduled_at !== undefined) data.scheduled_at = patch.scheduled_at;
  if (patch.odometer_km !== undefined) data.odometer_km = patch.odometer_km;
  if (patch.workshop !== undefined) data.workshop = patch.workshop;
  if (patch.notes !== undefined) data.notes = patch.notes;
  return data;
}
