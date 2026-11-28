import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { FailureComponent } from '../domain/failure';
import { MAINTENANCE_EVENTS, OPEN_STATUSES, maintenanceClosed, maintenanceNotFound, type MaintenanceStatus } from '../domain/maintenance';
import {
  MAX_TASKS_PER_ORDER,
  itemisedTotal,
  labourEntryNotFound,
  labourInFuture,
  needsApproval,
  notRequested,
  rateForbidden,
  taskMissing,
  taskNotFound,
  technicianMissing,
  tooManyTasks,
  vendorDepotMissing,
  vendorDuplicate,
  vendorFleetWideForbidden,
  vendorInOtherDepot,
  vendorMissing,
  vendorNotFound,
  type LabourEntryView,
  type TaskStatus,
  type TaskView,
  type VendorType,
  type VendorView,
  type WorkOrderView,
} from '../domain/work-order';
import type { MaintenanceRepository, RecordRow } from '../infrastructure/maintenance.repository';
import type { LabourRow, TaskRow, VendorRow, VendorWrite, WorkOrderRepository } from '../infrastructure/work-order.repository';
import type { RequestUser } from '../../../types/express';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

interface OrderVehicle {
  id: string;
  publicId: string;
  depotId: string;
  maintenanceFlag: boolean;
}

/** Statuses in which an order's plan (tasks, vendor) may change: anything not closed. */
export const EDITABLE_STATUSES: readonly MaintenanceStatus[] = ['requested', ...OPEN_STATUSES];

export interface VendorInput {
  name: string;
  vendor_type: VendorType;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  depot_id?: string | null;
  notes?: string | null;
}

export type VendorPatch = Partial<VendorInput> & { is_active?: boolean };

export interface VendorListQuery {
  page: number;
  page_size: number;
  vendor_type?: VendorType;
  search?: string;
  status: 'active' | 'retired' | 'all';
}

export interface TaskInput {
  description: string;
  component?: FailureComponent | null;
  estimated_hours?: number | null;
  status?: TaskStatus;
}

export interface LabourInput {
  technician_id: string;
  task_id?: string | null;
  work_date?: string;
  hours: number;
  rate_cents?: number;
  notes?: string | null;
}

export interface OrderVendorInput {
  vendor_id: string | null;
  vendor_invoice_ref?: string | null;
  vendor_cost_cents?: number;
}

export interface LabourWeek {
  technician_id: string;
  technician_name: string;
  /** The Monday the week starts on (Addis Ababa), YYYY-MM-DD. */
  week_start: string;
  hours: number;
  /** Null unless the caller holds labour-rate:read. */
  cost_cents: number | null;
  work_orders: number;
}

export interface WorkOrderServiceDeps {
  orders: WorkOrderRepository;
  records: Pick<MaintenanceRepository, 'lockForWrite' | 'findByPublicId' | 'findById' | 'partLines' | 'updateRecord'>;
  vehicles: {
    findInScope(db: Queryable, by: { publicId: string } | { id: string }, scope: Scope, lock?: boolean): Promise<(OrderVehicle & { isActive: boolean }) | null>;
    idsInScope(db: Queryable, scope: Scope): Promise<string[] | null>;
    setMaintenanceFlag(client: PoolClient, ctx: MutationContext, id: string, flag: boolean): Promise<unknown>;
  };
  users: {
    findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]>;
    activeHolder(db: Queryable, publicId: string, permission: string): Promise<{ id: string; depotId: string | null; unscoped: boolean } | null>;
    activeHoldersFor(db: Queryable, permission: string, depotId: string): Promise<{ publicId: string; fullName: string }[]>;
  };
  depots: {
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>>;
  };
  /** The approval threshold and the default labour rate, in whole ETB (settings registry). */
  settings: { approvalThresholdEtb(): Promise<number>; labourRateEtb(): Promise<number> };
  events: EventBus;
}

/** Labour rates and labour costs are for finance roles (FMS-130). */
function seesRates(user: RequestUser): boolean {
  return user.permissions.includes('labour-rate:read');
}

/**
 * Work orders (FMS-130, docs/work-orders.md). A repair record is the order: this service adds its tasks, the hours
 * technicians worked on it, its outside vendor, and its approval. Once an order has labour entries or a vendor it is
 * itemised: its total is parts + labour + vendor, recomputed in the same transaction as every change to them.
 */
export class WorkOrderService {
  constructor(private readonly deps: WorkOrderServiceDeps) {}

  // ---- vendors

  async listVendors(caller: Caller, query: VendorListQuery): Promise<{ items: VendorView[]; total: number }> {
    const scope = depotScope(caller.user);
    if (scope.kind === 'none' || scope.kind === 'own') return { items: [], total: 0 };
    return this.deps.orders.inTransaction(async (client) => {
      const { rows, total } = await this.deps.orders.listVendors(client, {
        page: query.page,
        page_size: query.page_size,
        depotId: scope.kind === 'depot' ? scope.depotId : null,
        vendorType: query.vendor_type,
        search: query.search,
        status: query.status,
      });
      return { items: await this.vendorViews(client, rows), total };
    });
  }

  async getVendor(caller: Caller, vendorId: string): Promise<VendorView> {
    return this.deps.orders.inTransaction(async (client) => {
      const row = await this.deps.orders.findVendor(client, vendorId);
      if (!row || !this.vendorVisible(caller, row)) throw vendorNotFound();
      return (await this.vendorViews(client, [row]))[0];
    });
  }

  async createVendor(caller: Caller, input: VendorInput): Promise<VendorView> {
    const ctx = mutationContext(caller);
    return this.deps.orders.inTransaction(async (client) => {
      const depotId = await this.vendorDepot(client, caller, input.depot_id ?? null);
      if (await this.deps.orders.vendorNameTaken(client, input.name, depotId, null)) throw vendorDuplicate();
      const row = await this.deps.orders.insertVendor(ctx, client, { ...vendorColumns(input), depot_id: depotId, created_by: caller.user.id });
      return (await this.vendorViews(client, [(await this.deps.orders.findVendor(client, row.public_id as string))!]))[0];
    });
  }

  async updateVendor(caller: Caller, vendorId: string, patch: VendorPatch, expectedVersion: number | null): Promise<VendorView> {
    const ctx = mutationContext(caller);
    return this.deps.orders.inTransaction(async (client) => {
      const row = await this.deps.orders.findVendor(client, vendorId, true);
      if (!row || !this.vendorVisible(caller, row)) throw vendorNotFound();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      const data: VendorWrite & { is_active?: boolean } = vendorColumns(patch);
      if (patch.depot_id !== undefined) data.depot_id = await this.vendorDepot(client, caller, patch.depot_id);
      if (patch.is_active !== undefined) data.is_active = patch.is_active;
      const active = data.is_active ?? row.isActive;
      if (active && (data.name !== undefined || data.depot_id !== undefined || (data.is_active === true && !row.isActive))) {
        const depot = data.depot_id !== undefined ? data.depot_id : row.depotId;
        if (await this.deps.orders.vendorNameTaken(client, data.name ?? row.name, depot, row.id)) throw vendorDuplicate();
      }
      if (Object.keys(data).length > 0) await this.deps.orders.updateVendor(ctx, client, row.id, data);
      return (await this.vendorViews(client, [(await this.deps.orders.findVendor(client, vendorId))!]))[0];
    });
  }

  // ---- an order's vendor, tasks and labour

  /** PUT /maintenance-records/{id}/vendor: the outside vendor that did (some of) the work, its invoice and its cost. */
  async setVendor(caller: Caller, recordId: string, input: OrderVendorInput): Promise<void> {
    await this.onOrder(caller, recordId, EDITABLE_STATUSES, async (client, row, vehicle, ctx) => {
      let vendorId: string | null = null;
      if (input.vendor_id !== null) {
        const vendor = await this.deps.orders.findVendor(client, input.vendor_id);
        if (!vendor || !vendor.isActive || !this.vendorVisible(caller, vendor)) throw vendorMissing();
        if (vendor.depotId !== null && vendor.depotId !== vehicle.depotId) throw vendorInOtherDepot();
        vendorId = vendor.id;
      }
      await this.deps.records.updateRecord(
        ctx,
        row.id,
        {
          vendor_id: vendorId,
          vendor_invoice_ref: vendorId === null ? null : (input.vendor_invoice_ref ?? null),
          vendor_cost_cents: vendorId === null ? 0 : (input.vendor_cost_cents ?? 0),
        },
        client,
      );
      await this.recompute(client, ctx, row.id);
      return ['vendor_id', 'vendor_invoice_ref', 'vendor_cost_cents'];
    });
  }

  async addTask(caller: Caller, recordId: string, input: TaskInput): Promise<void> {
    await this.onOrder(caller, recordId, EDITABLE_STATUSES, async (client, row, _vehicle, ctx) => {
      const count = await this.deps.orders.taskCount(client, row.id);
      if (count >= MAX_TASKS_PER_ORDER) throw tooManyTasks();
      await this.deps.orders.insertTask(ctx, client, {
        maintenance_record_id: row.id,
        description: input.description,
        component: input.component ?? null,
        estimated_hours: input.estimated_hours ?? null,
        status: input.status ?? 'pending',
        position: count,
        created_by: caller.user.id,
      });
      return ['tasks'];
    });
  }

  async updateTask(caller: Caller, recordId: string, taskId: string, patch: Partial<TaskInput>, expectedVersion: number | null): Promise<void> {
    await this.onOrder(caller, recordId, EDITABLE_STATUSES, async (client, row, _vehicle, ctx) => {
      const task = await this.deps.orders.findTask(client, row.id, taskId, true);
      if (!task) throw taskNotFound();
      if (expectedVersion !== null && expectedVersion !== task.version) throw staleVersion();
      const data: Record<string, unknown> = {};
      if (patch.description !== undefined) data.description = patch.description;
      if (patch.component !== undefined) data.component = patch.component;
      if (patch.estimated_hours !== undefined) data.estimated_hours = patch.estimated_hours;
      if (patch.status !== undefined) data.status = patch.status;
      await this.deps.orders.updateTask(ctx, client, task.id, data);
      return ['tasks'];
    });
  }

  async removeTask(caller: Caller, recordId: string, taskId: string): Promise<void> {
    await this.onOrder(caller, recordId, EDITABLE_STATUSES, async (client, row, _vehicle, ctx) => {
      const task = await this.deps.orders.findTask(client, row.id, taskId, true);
      if (!task) throw taskNotFound();
      await this.deps.orders.removeTask(ctx, client, task.id);
      return ['tasks'];
    });
  }

  /**
   * POST /maintenance-records/{id}/labour: hours a technician worked on the order. Only work under way (scheduled,
   * open, in progress): a request is not started, and closed work is final. The rate is the workshop's default
   * (labour_rate_etb_per_hour) unless a finance role sets one.
   */
  async addLabour(caller: Caller, recordId: string, input: LabourInput): Promise<void> {
    if (input.rate_cents !== undefined && !seesRates(caller.user)) throw rateForbidden();
    await this.onOrder(caller, recordId, OPEN_STATUSES, async (client, row, vehicle, ctx) => {
      const technician = await this.deps.users.activeHolder(client, input.technician_id, 'maintenance:execute');
      if (!technician || (!technician.unscoped && technician.depotId !== vehicle.depotId)) throw technicianMissing();
      let taskId: string | null = null;
      if (input.task_id) {
        const task = await this.deps.orders.findTask(client, row.id, input.task_id);
        if (!task) throw taskMissing();
        taskId = task.id;
      }
      const today = await this.deps.orders.today(client);
      const workDate = input.work_date ?? today;
      if (workDate > today) throw labourInFuture();
      const rate = input.rate_cents ?? (await this.deps.settings.labourRateEtb()) * 100;
      await this.deps.orders.insertLabour(ctx, client, {
        maintenance_record_id: row.id,
        task_id: taskId,
        technician_id: technician.id,
        work_date: workDate,
        hours: input.hours,
        rate_cents: rate,
        notes: input.notes ?? null,
        created_by: caller.user.id,
      });
      await this.recompute(client, ctx, row.id);
      return ['labour'];
    });
  }

  /** DELETE .../labour/{entry_id}: a mistaken entry comes off (soft delete, audited) and the totals follow. */
  async removeLabour(caller: Caller, recordId: string, entryId: string): Promise<void> {
    await this.onOrder(caller, recordId, OPEN_STATUSES, async (client, row, _vehicle, ctx) => {
      const entry = await this.deps.orders.findLabour(client, row.id, entryId);
      if (!entry) throw labourEntryNotFound();
      await this.deps.orders.removeLabour(ctx, client, entry.id);
      await this.recompute(client, ctx, row.id);
      return ['labour'];
    });
  }

  /**
   * POST /maintenance-records/{id}/approve (maintenance:approve): a requested order is approved and becomes open
   * work, which flags the vehicle for maintenance as any open work does.
   */
  async approve(caller: Caller, recordId: string): Promise<void> {
    await this.onOrder(caller, recordId, ['requested'], async (client, row, vehicle, ctx) => {
      if (row.status !== 'requested') throw notRequested();
      await this.deps.records.updateRecord(ctx, row.id, { status: 'open', approved_by: caller.user.id, approved_at: new Date().toISOString() }, client);
      if (!vehicle.maintenanceFlag) await this.deps.vehicles.setMaintenanceFlag(client, ctx, vehicle.id, true);
      return ['status', 'approved_by', 'approved_at'];
    }, notRequested);
  }

  /** GET /maintenance-records/{id}/technicians: who may book labour on this order (the vehicle's depot, or fleet-wide). */
  async technicians(caller: Caller, recordId: string): Promise<{ id: string; full_name: string }[]> {
    return this.deps.orders.inTransaction(async (client) => {
      const row = await this.deps.records.findByPublicId(client, recordId);
      const vehicle = row && (await this.deps.vehicles.findInScope(client, { id: row.vehicleId }, depotScope(caller.user)));
      if (!row || !vehicle) throw maintenanceNotFound();
      return (await this.deps.users.activeHoldersFor(client, 'maintenance:execute', vehicle.depotId)).map((u) => ({ id: u.publicId, full_name: u.fullName }));
    });
  }

  /** GET /labour-hours: hours per technician per week, on work orders of vehicles in the caller's depots. */
  async labourByWeek(caller: Caller, query: { from: string; to: string; technician_id?: string }): Promise<LabourWeek[]> {
    return this.deps.orders.inTransaction(async (client) => {
      const vehicleIds = await this.deps.vehicles.idsInScope(client, depotScope(caller.user));
      let technicianId: string | undefined;
      if (query.technician_id) {
        const holder = await this.deps.users.activeHolder(client, query.technician_id, 'maintenance:execute');
        if (!holder) return [];
        technicianId = holder.id;
      }
      const rows = await this.deps.orders.labourByWeek(client, { vehicleIds, from: query.from, to: query.to, technicianId });
      const names = await this.userNames(client, rows.map((r) => r.technicianId));
      const rates = seesRates(caller.user);
      return rows.map((r) => ({
        technician_id: names.get(r.technicianId)?.publicId ?? '',
        technician_name: names.get(r.technicianId)?.fullName ?? '',
        week_start: r.weekStart,
        hours: r.hours,
        cost_cents: rates ? r.costCents : null,
        work_orders: r.orders,
      }));
    });
  }

  // ---- what MaintenanceService needs

  /** What each order adds to its record's view, for this caller (rates and labour costs for finance roles only). */
  async details(db: Queryable, caller: Caller, rows: readonly RecordRow[]): Promise<Map<string, WorkOrderView>> {
    if (rows.length === 0) return new Map();
    const ids = rows.map((r) => r.id);
    const [tasks, labour, vendors, threshold] = await Promise.all([
      this.deps.orders.tasksFor(db, ids),
      this.deps.orders.labourFor(db, ids),
      this.deps.orders.vendorsByIds(db, [...new Set(rows.flatMap((r) => (r.vendorId ? [r.vendorId] : [])))]),
      this.deps.settings.approvalThresholdEtb(),
    ]);
    const people = await this.userNames(db, [...new Set([...labour.map((l) => l.technicianId), ...rows.flatMap((r) => (r.approvedBy ? [r.approvedBy] : []))])]);
    const rates = seesRates(caller.user);
    return new Map(
      rows.map((r) => {
        const vendor = r.vendorId ? vendors.get(r.vendorId) : undefined;
        const lines = labour.filter((l) => l.recordId === r.id);
        const view: WorkOrderView = {
          itemised: isItemised(r, lines.length),
          approval_required: r.status === 'requested' && r.approvedAt === null && needsApproval(r.totalCostCents, threshold),
          approved_by: r.approvedBy ? (people.get(r.approvedBy)?.publicId ?? null) : null,
          approved_at: r.approvedAt,
          vendor: vendor ? { id: vendor.publicId, name: vendor.name, vendor_type: vendor.vendorType } : null,
          vendor_invoice_ref: r.vendorInvoiceRef,
          vendor_cost_cents: r.vendorCostCents,
          labour_cost_cents: rates ? r.labourCostCents : null,
          tasks: tasks.filter((t) => t.recordId === r.id).map(taskView),
          labour: lines.map((l) => labourView(l, people, rates)),
        };
        return [r.id, view];
      }),
    );
  }

  /** Whether the order's total and hours come from its items (labour entries or a vendor), so they cannot be typed. */
  async itemised(db: Queryable, row: RecordRow): Promise<boolean> {
    if (row.vendorId !== null || row.vendorCostCents > 0) return true;
    return (await this.deps.orders.withLabour(db, [row.id])).size > 0;
  }

  /** The order's total needs an approver before a request may start: above the threshold and not approved. */
  async approvalNeeded(row: RecordRow, totalCostCents: number): Promise<{ needed: boolean; thresholdEtb: number }> {
    const thresholdEtb = await this.deps.settings.approvalThresholdEtb();
    return { needed: row.approvedAt === null && needsApproval(totalCostCents, thresholdEtb), thresholdEtb };
  }

  // ---- internals

  /**
   * Locks the order and its vehicle (in the caller's depots), checks its status, runs the change, then publishes one
   * MaintenanceRecordUpdated naming what changed, all in one transaction.
   */
  private async onOrder(
    caller: Caller,
    recordId: string,
    statuses: readonly MaintenanceStatus[],
    change: (client: PoolClient, row: RecordRow, vehicle: OrderVehicle, ctx: MutationContext) => Promise<string[]>,
    wrongStatus: ((status: MaintenanceStatus) => Error) | null = null,
  ): Promise<void> {
    const ctx = mutationContext(caller);
    await this.deps.orders.inTransaction(async (client) => {
      const row = await this.deps.records.lockForWrite(client, recordId);
      const vehicle = row && (await this.deps.vehicles.findInScope(client, { id: row.vehicleId }, depotScope(caller.user), true));
      if (!row || !vehicle) throw maintenanceNotFound();
      if (!statuses.includes(row.status)) throw (wrongStatus ?? maintenanceClosed)(row.status);
      const changed = await change(client, row, vehicle, ctx);
      await this.deps.events.publish(client, [orderEvent(caller, row.publicId, vehicle.publicId, changed)]);
    });
  }

  /** An itemised order's labour hours, labour cost and total, from its entries, parts and vendor. */
  private async recompute(client: PoolClient, ctx: MutationContext, recordId: string): Promise<void> {
    const row = await this.deps.records.findById(client, recordId);
    const labour = await this.deps.orders.labourTotals(client, recordId);
    if (!isItemised(row, labour.entries)) {
      if (row.labourCostCents !== 0) await this.deps.records.updateRecord(ctx, recordId, { labour_cost_cents: 0 }, client);
      return;
    }
    const parts = (await this.deps.records.partLines(client, [recordId])).reduce((sum, l) => sum + l.quantity * l.unitCostCents, 0);
    const total = itemisedTotal(parts, labour.costCents, row.vendorCostCents);
    const data = {
      labour_cost_cents: labour.costCents,
      total_cost_cents: total,
      ...(labour.entries > 0 ? { labor_hours: labour.hours } : {}),
    };
    if (row.labourCostCents !== data.labour_cost_cents || row.totalCostCents !== total || (labour.entries > 0 && row.labourHours !== labour.hours)) {
      await this.deps.records.updateRecord(ctx, recordId, data, client);
    }
  }

  private vendorVisible(caller: Caller, row: VendorRow): boolean {
    const scope = depotScope(caller.user);
    if (scope.kind === 'all') return true;
    return scope.kind === 'depot' && (row.depotId === null || row.depotId === scope.depotId);
  }

  /** The vendor's depot (internal id) from its public id; a fleet-wide vendor needs fleet-wide access. */
  private async vendorDepot(db: Queryable, caller: Caller, publicId: string | null): Promise<string | null> {
    const scope = depotScope(caller.user);
    if (publicId === null) {
      if (scope.kind !== 'all') throw vendorFleetWideForbidden();
      return null;
    }
    const id = await this.deps.depots.resolveInScope(db, publicId, scope);
    if (!id) throw vendorDepotMissing();
    return id;
  }

  private async vendorViews(db: Queryable, rows: readonly VendorRow[]): Promise<VendorView[]> {
    const depots = await this.deps.depots.publicIds(db, [...new Set(rows.flatMap((r) => (r.depotId ? [r.depotId] : [])))]);
    return rows.map((r) => ({
      id: r.publicId,
      name: r.name,
      vendor_type: r.vendorType,
      contact_name: r.contactName,
      phone: r.phone,
      email: r.email,
      depot_id: r.depotId ? (depots.get(r.depotId) ?? null) : null,
      notes: r.notes,
      is_active: r.isActive,
      version: r.version,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
  }

  private async userNames(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; fullName: string }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    return new Map((await this.deps.users.findByIds(db, unique)).map((u) => [u.id, { publicId: u.publicId, fullName: u.fullName }]));
  }
}

function isItemised(row: RecordRow, labourEntries: number): boolean {
  return labourEntries > 0 || row.vendorId !== null || row.vendorCostCents > 0;
}

function taskView(t: TaskRow): TaskView {
  return {
    id: t.publicId,
    description: t.description,
    component: t.component,
    status: t.status,
    estimated_hours: t.estimatedHours,
    actual_hours: t.actualHours,
    position: t.position,
    version: t.version,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

function labourView(l: LabourRow, people: Map<string, { publicId: string; fullName: string }>, rates: boolean): LabourEntryView {
  return {
    id: l.publicId,
    task_id: l.taskPublicId,
    technician_id: people.get(l.technicianId)?.publicId ?? '',
    technician_name: people.get(l.technicianId)?.fullName ?? '',
    work_date: l.workDate,
    hours: l.hours,
    rate_cents: rates ? l.rateCents : null,
    cost_cents: rates ? l.costCents : null,
    notes: l.notes,
    created_at: l.createdAt,
  };
}

function vendorColumns(input: Partial<VendorInput>): VendorWrite {
  const data: VendorWrite = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.vendor_type !== undefined) data.vendor_type = input.vendor_type;
  if (input.contact_name !== undefined) data.contact_name = input.contact_name;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.email !== undefined) data.email = input.email;
  if (input.notes !== undefined) data.notes = input.notes;
  return data;
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

/** The same event as any other change of the record (FMS-73), naming what changed on the order. */
function orderEvent(caller: Caller, recordPublicId: string, vehiclePublicId: string, changed: string[]): DomainEvent {
  return createEvent(
    MAINTENANCE_EVENTS.updated,
    { maintenance_record_id: recordPublicId, vehicle_id: vehiclePublicId, changed_fields: [...changed].sort(), maintenance_flag_cleared: false },
    { actor: caller.user.publicId, correlationId: caller.correlationId },
    { aggregate: aggregateKey('maintenance', recordPublicId) },
  );
}

