import { AppError } from '../../../shared/errors/app-error';
import type { FailureComponent } from './failure';

// Work orders (FMS-130, docs/work-orders.md): a repair record with the jobs it is split into (tasks), the hours each
// technician worked on it (labour entries), and the outside vendor that did some of it. No parallel table: the
// order is maintenance.maintenance_records.

export const VENDOR_TYPES = ['workshop', 'dealer', 'tyres', 'parts'] as const;
export type VendorType = (typeof VENDOR_TYPES)[number];

export const TASK_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Up to this many tasks on one order. */
export const MAX_TASKS_PER_ORDER = 50;

/** The approval rule's and the default rate's parameters (settings registry, FMS-157). */
export const APPROVAL_THRESHOLD_KEY = 'work_order_approval_threshold_etb';
export const LABOUR_RATE_KEY = 'labour_rate_etb_per_hour';
export const DEFAULT_APPROVAL_THRESHOLD_ETB = 20_000;
export const DEFAULT_LABOUR_RATE_ETB = 300;

export interface VendorView {
  id: string;
  name: string;
  vendor_type: VendorType;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  /** Null: every depot may use it. */
  depot_id: string | null;
  notes: string | null;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface TaskView {
  id: string;
  description: string;
  component: FailureComponent | null;
  status: TaskStatus;
  estimated_hours: number | null;
  /** The hours of the labour entries booked to it. */
  actual_hours: number;
  position: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface LabourEntryView {
  id: string;
  task_id: string | null;
  technician_id: string;
  technician_name: string;
  /** The Addis Ababa day, YYYY-MM-DD. */
  work_date: string;
  hours: number;
  /** Cents per hour and hours x rate: null unless the caller holds labour-rate:read. */
  rate_cents: number | null;
  cost_cents: number | null;
  notes: string | null;
  created_at: Date;
}

/** What a work order adds to a repair record's view. */
export interface WorkOrderView {
  /** Labour entries or a vendor: the total is parts + labour + vendor and cannot be typed. */
  itemised: boolean;
  /** Its total is above the approval threshold and it has not been approved: it cannot start. */
  approval_required: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  vendor: { id: string; name: string; vendor_type: VendorType } | null;
  vendor_invoice_ref: string | null;
  vendor_cost_cents: number;
  /** The labour entries' costs added up: null unless the caller holds labour-rate:read. */
  labour_cost_cents: number | null;
  tasks: TaskView[];
  labour: LabourEntryView[];
}

/** An order's total once itemised: every part, every hour and the vendor's invoice. */
export function itemisedTotal(parts: number, labour: number, vendor: number): number {
  return parts + labour + vendor;
}

/** Whether a request at this cost needs an approver before it may start. Above the threshold, not at it. */
export function needsApproval(totalCostCents: number, thresholdEtb: number): boolean {
  return totalCostCents > thresholdEtb * 100;
}

export const vendorNotFound = () => new AppError(404, 'NOT_FOUND', 'Vendor not found.');

export const vendorMissing = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vendor does not exist, is retired, or is outside your depots.', [
    { field: 'vendor_id', reason: 'references_missing_record' },
  ]);

export const vendorInOtherDepot = () =>
  new AppError(400, 'VALIDATION_FAILED', "The vendor serves another depot than the vehicle's.", [{ field: 'vendor_id', reason: 'vendor_in_other_depot' }]);

export const vendorDuplicate = () =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'A vendor of that name already serves this depot.', [{ field: 'name', reason: 'duplicate' }]);

export const vendorDepotMissing = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The depot does not exist or is outside your depots.', [{ field: 'depot_id', reason: 'references_missing_record' }]);

/** Only an administrator or a fleet-wide user adds a vendor for the whole fleet. */
export const vendorFleetWideForbidden = () =>
  new AppError(400, 'VALIDATION_FAILED', 'A vendor for the whole fleet needs fleet-wide access; name a depot.', [
    { field: 'depot_id', reason: 'required' },
  ]);

export const taskNotFound = () => new AppError(404, 'NOT_FOUND', 'Task not found.');

export const taskMissing = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The task is not on this work order.', [{ field: 'task_id', reason: 'references_missing_record' }]);

export const tooManyTasks = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `A work order holds at most ${MAX_TASKS_PER_ORDER} tasks.`);

export const labourEntryNotFound = () => new AppError(404, 'NOT_FOUND', 'Labour entry not found.');

export const technicianMissing = () =>
  new AppError(400, 'VALIDATION_FAILED', "The technician does not exist, is not active, or is outside the vehicle's depot.", [
    { field: 'technician_id', reason: 'references_missing_record' },
  ]);

export const labourInFuture = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Labour cannot be booked on a day that has not come yet.', [{ field: 'work_date', reason: 'in_future' }]);

/** Setting a rate is for those who may see rates (labour-rate:read); the others book at the default rate. */
export const rateForbidden = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Only finance roles set a labour rate.', [{ field: 'rate_cents', reason: 'labour_rate_read_required' }]);

/** An itemised order's total and hours come from its parts, labour and vendor. */
export const totalIsItemised = (field: 'total_cost_cents' | 'labour_hours') =>
  new AppError(400, 'VALIDATION_FAILED', 'This work order is itemised: its total and hours come from its parts, labour entries and vendor.', [
    { field, reason: 'itemised_order' },
  ]);

export const approvalRequired = (thresholdEtb: number) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `Work above ${thresholdEtb.toLocaleString('en-US')} ETB must be approved before it starts.`, [
    { field: 'status', reason: 'approval_required' },
  ]);

export const notRequested = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'Only a requested work order is approved.', [{ field: 'status', reason: 'not_requested' }]);

/** Asking for work is not moving it back: an order that has started cannot become a request again. */
export const backToRequested = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'Work that has been scheduled or started cannot become a request again.', [
    { field: 'status', reason: 'back_to_requested' },
  ]);
