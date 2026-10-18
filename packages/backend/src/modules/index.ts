import type { AppModule } from '../shared/module';
import { authModule, provideDepotDirectory } from './auth';
import { depotDirectory, fleetModule, provideMaintenanceLookup, tripRefs } from './fleet';
import { provideFleetRefs, tripModule } from './trip';
import { fuelModule } from './fuel';
import { maintenanceModule, maintenanceRefs } from './maintenance';
import { alertModule } from './alert';
import { analyticsModule } from './analytics';
import { commandCenterModule } from './command-center';
import { evModule } from './ev';
import { integrationModule } from './integration';
import { auditModule } from './audit';

// Wiring between modules that cannot import each other: fleet imports auth's
// `authorize` and trip's trip-activity queries, and maintenance imports
// fleet, so auth and trip get fleet's lookups, and fleet gets maintenance's,
// from here, not by import.
provideDepotDirectory(depotDirectory);
provideFleetRefs(tripRefs);
provideMaintenanceLookup(maintenanceRefs);

/** Every module, in mount order. Add new modules here. */
export const modules: AppModule[] = [
  authModule,
  fleetModule,
  tripModule,
  fuelModule,
  maintenanceModule,
  alertModule,
  analyticsModule,
  commandCenterModule,
  evModule,
  integrationModule,
  auditModule,
];
