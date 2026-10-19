import { AppError } from '../../../shared/errors/app-error';

/** The fuels a log can name: shared.fuel_type. Electric is not bought by the litre. */
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'cng', 'lpg', 'other'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const FUEL_SOURCES = ['pump', 'fuel_card', 'bulk', 'manual'] as const;
export type FuelSource = (typeof FUEL_SOURCES)[number];

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
  recorded_at: Date;
  created_at: Date;
}

export const FUEL_EVENTS = {
  /** A purchase was recorded; the anomaly rules (FMS-82) read it. */
  logged: 'FuelLogged',
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

/** The odometer only goes up (api-contract §17): lower than the vehicle's reading or its last fuel log is refused. */
export const odometerRegression = (lastKm: number) =>
  new AppError(409, 'CONFLICT_ODOMETER_REGRESSION', `The odometer reading is lower than the last recorded one (${lastKm} km).`, [
    { field: 'odometer_km', reason: 'below_last_reading' },
  ]);
