import { AppError } from '../../../shared/errors/app-error';
import type { FailureEventView } from './failure';
import type { ServiceItem } from './inventory';

/** As in maintenance.maintenance_type / maintenance_status and chk_maintenance_priority. */
export const MAINTENANCE_TYPES = ['preventive', 'corrective', 'predictive', 'inspection', 'other'] as const;
export const MAINTENANCE_STATUSES = ['scheduled', 'open', 'in_progress', 'completed', 'cancelled'] as const;
export const MAINTENANCE_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;

export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

/** Work still to do: these keep a vehicle's maintenance flag set. */
export const OPEN_STATUSES: readonly MaintenanceStatus[] = ['scheduled', 'open', 'in_progress'];

/** One part used in a repair, at the cost it was charged. */
export interface MaintenancePartLine {
  part_id: string;
  part_number: string;
  name: string;
  quantity: number;
  unit_cost_cents: number;
  line_cost_cents: number;
}

/** A maintenance record as the API returns it (api-contract §10.1). Public ids only. */
export interface MaintenanceRecordView {
  id: string;
  vehicle_id: string;
  registration_number: string;
  maintenance_type: MaintenanceType;
  description: string | null;
  status: MaintenanceStatus;
  priority: MaintenancePriority;
  scheduled_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  odometer_km: number | null;
  labour_hours: number | null;
  /** Whole cents (ETB): never a fraction (api-contract §17). */
  total_cost_cents: number;
  /** The parts below, added up. */
  parts_cost_cents: number;
  workshop: string | null;
  notes: string | null;
  completed_by: string | null;
  /** The preventive service program this work carries out (FMS-129); completing it starts the program's count again. */
  service_program: { id: string; name: string } | null;
  parts: MaintenancePartLine[];
  /** What failed (FMS-125), oldest first. */
  failures: FailureEventView[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** When a wearing part or fluid was last changed on a vehicle (FMS-52): one per service item. */
export interface ServiceItemView {
  service_item: ServiceItem;
  /** Null: never changed in the system (the model then counts from the vehicle's build). */
  last_changed_at: Date | null;
  /** The completed repair that changed it. */
  maintenance_record_id: string | null;
  /** The odometer on that repair, if it was entered. */
  odometer_km: number | null;
  part_number: string | null;
}

/** Things the caller should know but that did not stop the write; returned in `meta.warnings`. */
export type MaintenanceWarning =
  /** More of the part was used than the stock record held: stock is now 0 and `shortfall` were not on record. */
  | { warning: 'LOW_STOCK'; part_id: string; part_number: string; stock_quantity: number; shortfall: number }
  | { warning: 'COST_BELOW_PARTS'; total_cost_cents: number; parts_cost_cents: number };

export const MAINTENANCE_EVENTS = {
  opened: 'MaintenanceRecordOpened',
  updated: 'MaintenanceRecordUpdated',
  completed: 'MaintenanceRecordCompleted',
} as const;

export const maintenanceNotFound = () => new AppError(404, 'NOT_FOUND', 'Maintenance record not found.');

/** A vehicle that does not exist or is outside the caller's depots, named in a path. */
export const maintenanceVehicleMissing = () => new AppError(404, 'NOT_FOUND', 'Vehicle not found.');

export const maintenanceVehicleNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle does not exist or is outside your depots.', [
    { field: 'vehicle_id', reason: 'references_missing_record' },
  ]);

export const maintenanceVehicleRetired = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'A retired vehicle cannot get new maintenance work.');

export const maintenanceClosed = (status: MaintenanceStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `The record is ${status} and can no longer be changed.`);

export const partNotFound = (index: number) =>
  new AppError(400, 'VALIDATION_FAILED', 'A part does not exist or is no longer stocked.', [
    { field: `parts.${index}.part_id`, reason: 'references_missing_record' },
  ]);

export const partInOtherDepot = (index: number) =>
  new AppError(400, 'VALIDATION_FAILED', "A part belongs to another depot's stock.", [
    { field: `parts.${index}.part_id`, reason: 'part_in_other_depot' },
  ]);

export const completedInFuture = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Work cannot be completed in the future.', [{ field: 'completed_at', reason: 'in_future' }]);

export const completedBeforeStart = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Work cannot be completed before it started.', [{ field: 'completed_at', reason: 'before_start' }]);
