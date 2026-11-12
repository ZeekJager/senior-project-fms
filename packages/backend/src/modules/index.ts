import { config } from '../config';
import type { AppModule } from '../shared/module';
import { authModule, provideDepotDirectory } from './auth';
import { depotDirectory, fleetModule, provideMaintenanceLookup, provideMeterSources, provideTripRisk, provideWarrantyExpiry, tripRefs } from './fleet';
import { provideDistanceLimits, provideExceptionPolicies, provideFleetRefs, provideMaintenanceRefs, provideRoutingClient, provideTripDelayMargins, provideTripPositions, provideTripTrack, ROUTING_TIMEOUT_MS, tripModule } from './trip';
import { fuelMeterReadings, fuelModule } from './fuel';
import { maintenanceModule, maintenanceRefs, warrantyRefs } from './maintenance';
import { alertModule } from './alert';
import { analyticsModule, tripRisk } from './analytics';
import { commandCenterModule } from './command-center';
import { evModule } from './ev';
import { ignitionTime, integrationGateway, integrationModule, trackingLookups } from './integration';
import { auditModule } from './audit';
import { settingsModule } from './settings';
import { backupModule } from './backup';
import { systemModule } from './system';
import { privacyModule } from './privacy';

// Wiring between modules that cannot import each other: fleet imports auth's
// `authorize` and trip's trip-activity queries, and maintenance imports
// fleet, so auth and trip get fleet's lookups, and fleet and trip get
// maintenance's, from here, not by import.
provideDepotDirectory(depotDirectory);
provideFleetRefs(tripRefs);
provideMaintenanceLookup(maintenanceRefs);
provideMaintenanceRefs(maintenanceRefs);
// The expiry job (fleet, FMS-26) warns of warranties ending (FMS-133), which maintenance keeps.
provideWarrantyExpiry(warrantyRefs.endingWithin);
// A trip's live state (FMS-95) shows its vehicle's newest position, which the integration module keeps (it imports trip).
provideTripPositions(trackingLookups.currentPosition);
// A trip's actual distance (FMS-145) is measured from the positions stored during it, which the integration module keeps.
provideTripTrack({ tripTrack: trackingLookups.tripTrack, tripTrackCounts: trackingLookups.tripTrackCounts });
// The trip delay alert (FMS-147) uses each depot's margins, kept with the telemetry rules' thresholds by the integration module.
provideTripDelayMargins(trackingLookups.tripDelayMargins);
// Assignment exceptions (FMS-151): each depot's policy, warn or approve, also kept with the thresholds.
provideExceptionPolicies(trackingLookups.exceptionPolicies);
// The driving distance limits (FMS-156): each depot's limits and load weights, kept with the thresholds too.
provideDistanceLimits(trackingLookups.distanceLimits);
// The trip risk model on the dispatch board (FMS-155): analytics reads its inputs and asks the model; fleet shows it.
provideTripRisk(tripRisk);
// Meter readings (FMS-126) are made from fuel logs, completed repairs and devices' ignition time.
provideMeterSources({ fuelLogs: fuelMeterReadings.odometers, repairs: maintenanceRefs.completedOdometers, ignitionSeconds: ignitionTime.seconds });
// Road routing (FMS-84): OSRM through the integration gateway (timeouts, a retry, its circuit breaker).
const routing = config.routing;
if (routing) {
  provideRoutingClient((correlationId) =>
    integrationGateway.internalClient({ code: 'osrm', baseUrl: routing.url, timeoutMs: ROUTING_TIMEOUT_MS, maxRetries: 1 }, correlationId),
  );
}

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
  settingsModule,
  backupModule,
  systemModule,
  privacyModule,
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
