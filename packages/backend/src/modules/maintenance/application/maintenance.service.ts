import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { createEvent } from '../../../shared/events/domain-event';
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
  maintenanceVehicleNotFound,
  maintenanceVehicleRetired,
  partInOtherDepot,
  partNotFound,
  type MaintenancePriority,
  type MaintenanceRecordView,
  type MaintenanceStatus,
  type MaintenanceType,
  type MaintenanceWarning,
} from '../domain/maintenance';
import type { MaintenanceRepository, RecordRow, RecordWrite } from '../infrastructure/maintenance.repository';

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

export interface MaintenanceServiceDeps {
  records: Pick<
    MaintenanceRepository,
    'inTransaction' | 'list' | 'findByPublicId' | 'findById' | 'lockForWrite' | 'partLines' | 'hasOtherOpen' | 'lockParts' | 'insertRecord' | 'updateRecord' | 'consumePart'
  >;
  vehicles: {
    findInScope(db: Queryable, by: { publicId: string } | { id: string }, scope: Scope, lock?: boolean): Promise<MaintenanceVehicle | null>;
    refsByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; registrationNumber: string }>>;
    idsInScope(db: Queryable, scope: Scope): Promise<string[] | null>;
    setMaintenanceFlag(client: PoolClient, ctx: MutationContext, id: string, flag: boolean): Promise<unknown>;
  };
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string }[]> };
  events: EventBus;
  now?: () => Date;
}

/** A completion a few minutes "in the future" is clock skew between devices, not a mistake. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Maintenance records (FMS-22): every repair on every vehicle, permanently and
 * audited. Opening work flags the vehicle for maintenance in the same
 * transaction; finishing the last open work on it clears the flag in the
 * same transaction. Parts used come off the shelf; using more than the
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
      for (const use of uses) {
        const part = locked.get(use.part_id)!;
        const { stock, shortfall } = await records.consumePart(ctx, client, {
          recordId: row.id as string,
          part,
          quantity: use.quantity,
          unitCostCents: use.unit_cost_cents,
          vehicleDepotId: vehicle.depotId,
          performedBy: caller.user.id,
        });
        part.stockQuantity = stock;
        if (shortfall > 0) {
          warnings.push({ warning: 'LOW_STOCK', part_id: part.publicId, part_number: part.partNumber, stock_quantity: stock, shortfall });
        }
      }

      if (!vehicle.maintenanceFlag) await vehicles.setMaintenanceFlag(client, ctx, vehicle.id, true);
      const record = (await this.views(client, [await records.findById(client, row.id as string)]))[0];
      if (record.total_cost_cents < record.parts_cost_cents) {
        warnings.push({ warning: 'COST_BELOW_PARTS', total_cost_cents: record.total_cost_cents, parts_cost_cents: record.parts_cost_cents });
      }
      return { record, warnings };
    });

    await this.publish(caller, MAINTENANCE_EVENTS.opened, { maintenance_record_id: result.record.id, vehicle_id: result.record.vehicle_id });
    return result;
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
    const { view, flagCleared, closing } = await records.inTransaction(async (client) => {
      const row = await records.lockForWrite(client, recordId);
      const vehicle = row && (await vehicles.findInScope(client, { id: row.vehicleId }, depotScope(caller.user), true));
      if (!row || !vehicle) throw maintenanceNotFound();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      if (!OPEN_STATUSES.includes(row.status)) throw maintenanceClosed(row.status);

      const data = toColumns(patch);
      const now = this.now();
      if (patch.completed_at !== undefined || patch.status === 'completed') {
        const completedAt = patch.completed_at ? new Date(patch.completed_at) : now;
        if (completedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) throw completedInFuture();
        if (row.startedAt && completedAt < row.startedAt) throw completedBeforeStart();
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
      return { view: (await this.views(client, [await records.findById(client, row.id)]))[0], flagCleared: cleared, closing: data.status };
    });

    if (closing === 'completed') {
      await this.publish(caller, MAINTENANCE_EVENTS.completed, {
        maintenance_record_id: view.id,
        vehicle_id: view.vehicle_id,
        maintenance_flag_cleared: flagCleared,
      });
    } else {
      await this.publish(caller, MAINTENANCE_EVENTS.updated, {
        maintenance_record_id: view.id,
        vehicle_id: view.vehicle_id,
        changed_fields: Object.keys(patch).sort(),
        maintenance_flag_cleared: flagCleared,
      });
    }
    return view;
  }

  private async views(db: Queryable, rows: RecordRow[]): Promise<MaintenanceRecordView[]> {
    if (rows.length === 0) return [];
    const lines = await this.deps.records.partLines(db, rows.map((r) => r.id));
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
        version: r.version,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      };
    });
  }

  private publish(caller: Caller, type: string, payload: Record<string, unknown>): Promise<void> {
    return this.deps.events.publish([createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId })]);
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
