import type { AppModule } from '../../shared/module';

export const tripModule: AppModule = { name: 'trip' };

/**
 * For other modules: whether a vehicle or driver is on an assigned or
 * en-route trip (fleet blocks retirement), and each vehicle's current trip
 * (the vehicle and driver lists show it).
 */
export {
  activeTripsForDrivers,
  activeTripsForVehicles,
  driverHasActiveTrip,
  vehicleHasActiveTrip,
  type ActiveTrip,
} from './infrastructure/trip-activity.queries';
