import { AppError } from '../../../shared/errors/app-error';

/** How the inventory screen (FMS-28) colours a part: out of stock, at or below its reorder point, fine. */
export type StockStatus = 'out' | 'low' | 'ok';

/** Must match the stock_status filter in InventoryRepository.list. */
export function stockStatus(stock: number, reorderThreshold: number): StockStatus {
  if (stock <= 0) return 'out';
  if (stock <= reorderThreshold) return 'low';
  return 'ok';
}

/** A spare part as the API returns it (api-contract §10.1). Public ids only. */
export interface InventoryPartView {
  id: string;
  part_number: string;
  name: string;
  description: string | null;
  /** The depot holding the stock; null for stock shared by every depot. */
  depot_id: string | null;
  /** Whole cents (ETB), or null if not priced yet. */
  unit_cost_cents: number | null;
  stock_quantity: number;
  /** Reorder when stock is at or below this ("reorder level"). */
  reorder_threshold: number;
  below_reorder: boolean;
  stock_status: StockStatus;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** One line of a part's stock ledger (maintenance.inventory_movements). */
export interface InventoryMovementView {
  id: string;
  movement_type: 'purchase' | 'consumption' | 'adjustment' | 'transfer_in' | 'transfer_out' | 'return';
  quantity_delta: number;
  reference_type: string | null;
  notes: string | null;
  performed_by: string | null;
  occurred_at: Date;
}

export const INVENTORY_EVENTS = {
  created: 'InventoryPartCreated',
  updated: 'InventoryPartUpdated',
  adjusted: 'InventoryStockAdjusted',
  /** Stock fell to or below the reorder threshold (it was above before). */
  reorderNeeded: 'InventoryReorderNeeded',
} as const;

export const partNotFoundById = () => new AppError(404, 'NOT_FOUND', 'Part not found.');

export const insufficientStock = (stock: number, quantity: number) =>
  new AppError(409, 'CONFLICT_INSUFFICIENT_STOCK', `Only ${stock} in stock: cannot take out ${-quantity}.`, [
    { field: 'quantity', reason: 'insufficient_stock' },
  ]);

export const inventoryDepotNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The depot does not exist or is outside your depots.', [
    { field: 'depot_id', reason: 'references_missing_record' },
  ]);

/** Stock shared by every depot is managed by those who see every depot. */
export const sharedStockForbidden = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Only a fleet-wide role can manage shared stock: give a depot_id.');
