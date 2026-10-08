import type { AppModule } from '../../shared/module';

export const tripModule: AppModule = { name: 'trip' };

/** For other modules: whether a vehicle is on an assigned or en-route trip (fleet blocks retirement). */
export { vehicleHasActiveTrip } from './infrastructure/trip-activity.queries';
