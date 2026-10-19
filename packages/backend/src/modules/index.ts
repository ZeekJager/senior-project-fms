import type { AppModule } from '../shared/module';
import { authModule, provideDepotDirectory } from './auth';
import { depotDirectory, fleetModule, provideMaintenanceLookup, tripRefs } from './fleet';
import { provideFleetRefs, provideMaintenanceRefs, tripModule } from './trip';
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
// fleet, so auth and trip get fleet's lookups, and fleet and trip get
// maintenance's, from here, not by import.
provideDepotDirectory(depotDirectory);
provideFleetRefs(tripRefs);
provideMaintenanceLookup(maintenanceRefs);
provideMaintenanceRefs(maintenanceRefs);

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

/**
 * Rebuilds every module's read models from their sources, in module order.
 * For anything that wrote data without publishing its events: the seed, a
 * bulk import, a restore. Returns what each rebuild changed, by table.
 */
export async function rebuildReadModels(): Promise<Record<string, Record<string, unknown>>> {
  const results: Record<string, Record<string, unknown>> = {};
  for (const model of modules.flatMap((m) => m.readModels ?? [])) results[model.name] = await model.rebuild();
  return results;
}
