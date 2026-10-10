import { DatabaseError } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import {
  INVENTORY_EVENTS,
  insufficientStock,
  inventoryDepotNotFound,
  partNotFoundById,
  sharedStockForbidden,
  stockStatus,
  type InventoryMovementView,
  type InventoryPartView,
} from '../domain/inventory';
import type { InventoryRepository, PartRow, PartWrite } from '../infrastructure/inventory.repository';
import type { Caller } from './maintenance.service';

export interface PartCreate {
  part_number: string;
  name: string;
  description?: string | null;
  /** The depot holding the stock (public id); null or absent: shared by every depot. */
  depot_id?: string | null;
  unit_cost_cents?: number | null;
  reorder_threshold?: number;
  /** Opening stock, recorded in the ledger as a purchase. */
  stock_quantity?: number;
}

export type PartUpdate = Partial<Omit<PartCreate, 'stock_quantity'>> & { is_active?: boolean };

export interface PartListQuery {
  page: number;
  page_size: number;
  depot_id?: string;
  below_reorder?: boolean;
  search?: string;
  status: 'active' | 'inactive' | 'all';
  sort_by: 'part_number' | 'name' | 'stock_quantity';
  sort_order: 'asc' | 'desc';
}

export interface InventoryServiceDeps {
  parts: Pick<InventoryRepository, 'inTransaction' | 'list' | 'findVisible' | 'findById' | 'movements' | 'insert' | 'update' | 'recordMovement'>;
  /** The fleet module's depots (through its index.ts): resolve a public id in scope, name internal ids. */
  depots: {
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>>;
  };
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string }[]> };
  events: EventBus;
}

/**
 * Spare parts (FMS-23): what is on the shelf, where, and when to reorder.
 * Stock changes only through the ledger: opening stock, manual adjustments
 * here, consumption by repairs (MaintenanceService). It never goes below zero
 * (CHECK): an adjustment that would is 409 CONFLICT_INSUFFICIENT_STOCK.
 */
export class InventoryService {
  constructor(private readonly deps: InventoryServiceDeps) {}

  async list(caller: Caller, query: PartListQuery): Promise<{ items: InventoryPartView[]; total: number }> {
    const { parts, depots } = this.deps;
    return parts.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      let depotId: string | undefined;
      if (query.depot_id) {
        const resolved = await depots.resolveInScope(client, query.depot_id, scope);
        if (!resolved) return { items: [], total: 0 };
        depotId = resolved;
      }
      const { rows, total } = await parts.list(client, {
        page: query.page,
        page_size: query.page_size,
        scope,
        depotId,
        belowReorder: query.below_reorder,
        search: query.search,
        status: query.status,
        sortBy: query.sort_by,
        sortOrder: query.sort_order,
      });
      return { items: await this.views(client, rows), total };
    });
  }

  async get(caller: Caller, partId: string): Promise<InventoryPartView> {
    const { parts } = this.deps;
    return parts.inTransaction(async (client) => {
      const row = await parts.findVisible(client, partId, depotScope(caller.user));
      if (!row) throw partNotFoundById();
      return (await this.views(client, [row]))[0];
    });
  }

  async movements(caller: Caller, partId: string, page: { page: number; page_size: number }): Promise<{ items: InventoryMovementView[]; total: number }> {
    const { parts, users } = this.deps;
    return parts.inTransaction(async (client) => {
      const row = await parts.findVisible(client, partId, depotScope(caller.user));
      if (!row) throw partNotFoundById();
      const { rows, total } = await parts.movements(client, row.id, page);
      const people = new Map((await users.findByIds(client, [...new Set(rows.flatMap((r) => (r.performedBy ? [r.performedBy] : [])))])).map((u) => [u.id, u.publicId]));
      return {
        total,
        items: rows.map((r) => ({
          id: r.id,
          movement_type: r.movementType,
          quantity_delta: r.quantityDelta,
          reference_type: r.referenceType,
          notes: r.notes,
          performed_by: r.performedBy ? (people.get(r.performedBy) ?? null) : null,
          occurred_at: r.occurredAt,
        })),
      };
    });
  }

  async create(caller: Caller, input: PartCreate): Promise<InventoryPartView> {
    const { parts } = this.deps;
    const ctx = mutationContext(caller);
    const view = await parts.inTransaction(async (client) => {
      const depotId = await this.depotFor(client, caller, input.depot_id ?? null);
      const opening = input.stock_quantity ?? 0;
      const row = await parts.insert(
        ctx,
        {
          part_number: input.part_number,
          name: input.name,
          description: input.description ?? null,
          depot_id: depotId,
          unit_cost_cents: input.unit_cost_cents ?? null,
          reorder_threshold: input.reorder_threshold ?? 0,
          stock_quantity: opening,
        },
        client,
      );
      if (opening > 0) {
        await parts.recordMovement(ctx, client, { partId: row.id as string, depotId, type: 'purchase', delta: opening, notes: 'Opening stock', performedBy: caller.user.id });
      }
      return (await this.views(client, [await parts.findById(client, row.id as string)]))[0];
    });
    await this.publish([event(caller, INVENTORY_EVENTS.created, { part_id: view.id, depot_id: view.depot_id })]);
    return view;
  }

  /** PUT /inventory/{id}: the fields sent (not stock: that moves only through adjust and repairs). */
  async update(caller: Caller, partId: string, patch: PartUpdate, expectedVersion: number | null): Promise<InventoryPartView> {
    const { parts } = this.deps;
    const { view, changed } = await parts.inTransaction(async (client) => {
      const row = await parts.findVisible(client, partId, depotScope(caller.user), true);
      if (!row) throw partNotFoundById();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      if (row.depotId === null && depotScope(caller.user).kind !== 'all') throw sharedStockForbidden();
      const data: PartWrite = {};
      for (const key of ['part_number', 'name', 'description', 'unit_cost_cents', 'reorder_threshold', 'is_active'] as const) {
        if (patch[key] !== undefined) (data as Record<string, unknown>)[key] = patch[key];
      }
      if (patch.depot_id !== undefined) data.depot_id = await this.depotFor(client, caller, patch.depot_id);
      const changedFields = Object.keys(data).sort();
      if (changedFields.length > 0) await parts.update(mutationContext(caller), row.id, data, client);
      return { view: (await this.views(client, [await parts.findById(client, row.id)]))[0], changed: changedFields };
    });
    if (changed.length > 0) await this.publish([event(caller, INVENTORY_EVENTS.updated, { part_id: view.id, changed_fields: changed })]);
    return view;
  }

  /**
   * POST /inventory/{id}/adjust: stock in (+) or out (-) outside a repair, with
   * a reason. The part row is locked; stock that would go below zero is 409
   * CONFLICT_INSUFFICIENT_STOCK (the DB CHECK is the backstop). One audit row
   * shows the old and new stock_quantity; one ledger line keeps the reason.
   */
  async adjust(caller: Caller, partId: string, input: { quantity: number; reason: string }): Promise<InventoryPartView> {
    const { parts } = this.deps;
    const ctx = mutationContext(caller);
    const { view, before } = await parts.inTransaction(async (client) => {
      const row = await parts.findVisible(client, partId, depotScope(caller.user), true);
      if (!row) throw partNotFoundById();
      if (!row.isActive) throw partNotFoundById();
      const next = row.stockQuantity + input.quantity;
      if (next < 0) throw insufficientStock(row.stockQuantity, input.quantity);
      try {
        await parts.update(ctx, row.id, { stock_quantity: next }, client);
      } catch (err) {
        if (err instanceof DatabaseError && err.code === '23514') throw insufficientStock(row.stockQuantity, input.quantity);
        throw err;
      }
      await parts.recordMovement(ctx, client, { partId: row.id, depotId: row.depotId, type: 'adjustment', delta: input.quantity, notes: input.reason, performedBy: caller.user.id });
      return { view: (await this.views(client, [await parts.findById(client, row.id)]))[0], before: row };
    });

    const events: DomainEvent[] = [
      event(caller, INVENTORY_EVENTS.adjusted, { part_id: view.id, quantity_delta: input.quantity, stock_quantity: view.stock_quantity, reason: input.reason }),
    ];
    if (before.stockQuantity > before.reorderThreshold && view.below_reorder) {
      events.push(event(caller, INVENTORY_EVENTS.reorderNeeded, reorderPayload(view)));
    }
    await this.publish(events);
    return view;
  }

  /** A depot for a part: one in the caller's scope, or null (shared), which only a fleet-wide role may choose. */
  private async depotFor(db: Queryable, caller: Caller, depotPublicId: string | null): Promise<string | null> {
    const scope = depotScope(caller.user);
    if (depotPublicId === null) {
      if (scope.kind !== 'all') throw sharedStockForbidden();
      return null;
    }
    const id = await this.deps.depots.resolveInScope(db, depotPublicId, scope);
    if (!id) throw inventoryDepotNotFound();
    return id;
  }

  private async views(db: Queryable, rows: PartRow[]): Promise<InventoryPartView[]> {
    const depots = await this.deps.depots.publicIds(db, [...new Set(rows.flatMap((r) => (r.depotId ? [r.depotId] : [])))]);
    return rows.map((r) => ({
      id: r.publicId,
      part_number: r.partNumber,
      name: r.name,
      description: r.description,
      depot_id: r.depotId ? (depots.get(r.depotId) ?? null) : null,
      unit_cost_cents: r.unitCostCents,
      stock_quantity: r.stockQuantity,
      reorder_threshold: r.reorderThreshold,
      below_reorder: r.stockQuantity <= r.reorderThreshold,
      stock_status: stockStatus(r.stockQuantity, r.reorderThreshold),
      is_active: r.isActive,
      version: r.version,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
  }

  private publish(events: DomainEvent[]): Promise<void> {
    return this.deps.events.publish(events);
  }
}

export function reorderPayload(part: { id: string; part_number: string; depot_id: string | null; stock_quantity: number; reorder_threshold: number }) {
  return {
    part_id: part.id,
    part_number: part.part_number,
    depot_id: part.depot_id,
    stock_quantity: part.stock_quantity,
    reorder_threshold: part.reorder_threshold,
  };
}

function event(caller: Caller, type: string, payload: Record<string, unknown>): DomainEvent {
  return createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId });
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
