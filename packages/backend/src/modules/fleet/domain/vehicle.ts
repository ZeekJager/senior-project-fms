import { AppError } from '../../../shared/errors/app-error';

/** Enum values exactly as stored (shared.vehicle_type, shared.fuel_type, shared.vehicle_status). */
export const VEHICLE_TYPES = ['car', 'suv', 'van', 'truck', 'bus', 'motorcycle', 'other'] as const;
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'cng', 'lpg', 'other'] as const;
export const VEHICLE_STATUSES = ['active', 'inactive', 'maintenance', 'retired', 'decommissioned'] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];
export type FuelType = (typeof FUEL_TYPES)[number];
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/** A vehicle as the API returns it (api-contract §16.1). Public ids only. */
export interface VehicleView {
  id: string;
  registration_number: string;
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  vehicle_type: VehicleType;
  fuel_type: FuelType;
  fuel_efficiency_ml_per_km: number | null;
  status: VehicleStatus;
  maintenance_flag: boolean;
  health_score: number | null;
  depot_id: string;
  odometer_km: number;
  /** Bumped on every change; also the ETag. Send it back in `If-Match` to refuse a stale PATCH. */
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Event types this module publishes (CONVENTIONS.md, Events). */
export const VEHICLE_EVENTS = {
  registered: 'VehicleRegistered',
  updated: 'VehicleUpdated',
  retired: 'VehicleRetired',
} as const;

/**
 * Registration numbers are unique and normalized (api-contract §17): trimmed,
 * upper case, single spaces. "aa  3-12345 " and "AA 3-12345" are the same plate,
 * so the unique constraint catches both.
 */
export function normalizeRegistration(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** VINs are stored upper case without surrounding spaces. */
export function normalizeVin(raw: string): string {
  return raw.trim().toUpperCase();
}

/** ISO 3779: 17 characters, digits and capitals except I, O and Q. */
export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * Expected consumption is the basis of fuel reconciliation, so every vehicle
 * that burns fuel needs it; it means nothing for an electric one.
 */
export function requiresFuelEfficiency(fuelType: FuelType): boolean {
  return fuelType !== 'electric';
}

export const vehicleNotFound = () => new AppError(404, 'NOT_FOUND', 'Vehicle not found.');

export const vehicleInUse = () =>
  new AppError(409, 'CONFLICT_VEHICLE_IN_USE', 'The vehicle is on an active trip or assigned to a driver. End that first.');

export const vehicleRetired = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'A retired vehicle cannot be changed.');

export const odometerRegression = () =>
  new AppError(409, 'CONFLICT_ODOMETER_REGRESSION', 'The odometer reading is lower than the current one.');

export const fuelEfficiencyRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Fuel efficiency is required unless the vehicle is electric.', [
    { field: 'fuel_efficiency_ml_per_km', reason: 'required' },
  ]);

export const depotNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The depot does not exist.', [
    { field: 'depot_id', reason: 'references_missing_record' },
  ]);
