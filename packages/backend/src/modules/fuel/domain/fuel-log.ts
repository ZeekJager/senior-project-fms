import { AppError } from '../../../shared/errors/app-error';

/** The fuels a log can name: shared.fuel_type. Electric is not bought by the litre. */
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'cng', 'lpg', 'other'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const FUEL_SOURCES = ['pump', 'fuel_card', 'bulk', 'manual'] as const;
export type FuelSource = (typeof FUEL_SOURCES)[number];

/**
 * `fueled_at` (FMS-115): when the fill-up happened, sent by a form that may have queued it offline. At most
 * this many days old, as a DVIR's `submitted_at` (FMS-36): the offline queue keeps nothing longer.
 */
export const MAX_FUELED_AGE_DAYS = 30;
/** How far ahead of the server clock `fueled_at` may be: a phone clock running a little fast. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** A fuel purchase as the API returns it (api-contract §9.1). Public ids only; volume in millilitres, money in cents. */
export interface FuelLogView {
  id: string;
  vehicle_id: string;
  /** Who filled up; null when a clerk logs a purchase that is not tied to a driver. */
  driver_id: string | null;
  trip_id: string | null;
  fuel_type: FuelType;
  quantity_ml: number;
  unit_price_cents: number | null;
  total_cost_cents: number;
  odometer_km: number | null;
  station_name: string | null;
  source: FuelSource;
  /** When the fill-up happened: `fueled_at` if given, else when the server received it. */
  recorded_at: Date;
  created_at: Date;
}

export const FUEL_EVENTS = {
  /** A purchase was recorded; the anomaly rules (FMS-82) read it. */
  logged: 'FuelLogged',
  /** A vehicle's fuel was outside what it should be: a month's reconciliation (FMS-41) or a fill-up's rules (FMS-82). */
  anomalyDetected: 'FuelAnomalyDetected',
} as const;

export const fuelLogNotFound = () => new AppError(404, 'NOT_FOUND', 'Fuel log not found.');

export const fuelVehicleNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle does not exist or is outside your depots.', [{ field: 'vehicle_id', reason: 'references_missing_record' }]);

export const fuelVehicleRetired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle has been retired: fuel cannot be logged for it.', [{ field: 'vehicle_id', reason: 'vehicle_retired' }]);

export const electricVehicle = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Electric vehicles are charged, not fuelled: use a fuel type the vehicle takes.', [{ field: 'fuel_type', reason: 'not_a_liquid_fuel' }]);

export const fuelTripNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The trip does not exist or is not yours to see.', [{ field: 'trip_id', reason: 'references_missing_record' }]);

export const tripVehicleMismatch = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The trip is assigned to a different vehicle.', [{ field: 'trip_id', reason: 'trip_vehicle_mismatch' }]);

export const fuelDriverNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The driver does not exist or is outside your depots.', [{ field: 'driver_id', reason: 'references_missing_record' }]);

/** A driver's logs are their own: they cannot name someone else. */
export const driverNotWritable = () =>
  new AppError(400, 'VALIDATION_FAILED', 'A driver logs fuel for themselves: leave driver_id out.', [{ field: 'driver_id', reason: 'not_writable' }]);

export const noDriverProfile = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Your account has no driver profile, so it cannot log fuel.', [{ field: 'driver_id', reason: 'no_driver_profile' }]);

export const fueledInFuture = () =>
  new AppError(400, 'VALIDATION_FAILED', 'fueled_at cannot be in the future.', [{ field: 'fueled_at', reason: 'in_future' }]);

export const fueledTooOld = () =>
  new AppError(400, 'VALIDATION_FAILED', `fueled_at cannot be more than ${MAX_FUELED_AGE_DAYS} days ago.`, [{ field: 'fueled_at', reason: 'too_old' }]);

/**
 * The odometer only goes up with time (api-contract §17): a reading lower than the vehicle's, or than a fuel log
 * from before this fill-up, is refused.
 */
export const odometerRegression = (lastKm: number) =>
  new AppError(409, 'CONFLICT_ODOMETER_REGRESSION', `The odometer reading is lower than the last recorded one (${lastKm} km).`, [
    { field: 'odometer_km', reason: 'below_last_reading' },
  ]);

/** A back-dated fill-up (FMS-115) reading more than a fuel log from after it: one of the two readings is wrong. */
export const odometerAheadOfLater = (laterKm: number) =>
  new AppError(409, 'CONFLICT_ODOMETER_REGRESSION', `The odometer reading is higher than a later fill-up's (${laterKm} km).`, [
    { field: 'odometer_km', reason: 'above_later_reading' },
  ]);
