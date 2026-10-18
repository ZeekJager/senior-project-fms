import type { AppModule } from '../shared/module';
import { authModule, provideDepotDirectory } from './auth';
import { depotDirectory, depotRefs, fleetModule } from './fleet';
import { provideDepotRefs, tripModule } from './trip';
import { fuelModule } from './fuel';
import { maintenanceModule } from './maintenance';
import { alertModule } from './alert';
import { analyticsModule } from './analytics';
import { commandCenterModule } from './command-center';
import { evModule } from './ev';
import { integrationModule } from './integration';
import { auditModule } from './audit';

// Wiring between modules that cannot import each other: fleet imports auth's
// `authorize` and trip's trip-activity queries, so auth and trip get fleet's
// depot lookups from here, not by import.
provideDepotDirectory(depotDirectory);
provideDepotRefs(depotRefs);

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
