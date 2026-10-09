import type { AppModule } from '../shared/module';
import { authModule, provideDepotDirectory } from './auth';
import { depotDirectory, fleetModule } from './fleet';
import { tripModule } from './trip';
import { fuelModule } from './fuel';
import { maintenanceModule } from './maintenance';
import { alertModule } from './alert';
import { analyticsModule } from './analytics';
import { commandCenterModule } from './command-center';
import { evModule } from './ev';
import { integrationModule } from './integration';
import { auditModule } from './audit';

// Wiring between modules that cannot import each other: fleet imports auth's
// `authorize`, so auth gets fleet's depot lookup from here, not by import.
provideDepotDirectory(depotDirectory);

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
