import { pool } from '../../db';
import { cache } from '../../shared/cache';
import { eventBus } from '../../shared/events/event-bus';
import type { AppModule } from '../../shared/module';
import { ALERT_EVENTS, commandCenterFeed, INCIDENT_EVENTS } from '../alert';
import { ATTENDANCE_EVENTS, commandCenterRefs, HEALTH_BANDS, VEHICLE_EVENTS } from '../fleet';
import { TRIP_EVENTS, tripBoard } from '../trip';
import { commandCenterRouter } from './api/command-center.routes';
import { OverviewService } from './application/overview.service';

// The command center (FMS-89, architecture §11): owns no schema, and reads fleet, trip and alert through their
// index.ts. The overview counts what needs attention on the live map; the map itself is the integration module's
// snapshot (FMS-45).

const overview = new OverviewService({
  db: pool,
  refs: {
    depots: commandCenterRefs.depots,
    vehicles: commandCenterRefs.vehicles,
    drivers: commandCenterRefs.drivers,
    trips: tripBoard,
    alerts: commandCenterFeed.alerts,
    incidents: commandCenterFeed.incidents,
  },
  cache,
  bands: HEALTH_BANDS,
});

// Anything the overview counts drops it after commit, so a console re-reading on the socket's event sees the change.
for (const type of [
  ...Object.values(ALERT_EVENTS),
  ...Object.values(INCIDENT_EVENTS),
  ...Object.values(TRIP_EVENTS),
  ...Object.values(VEHICLE_EVENTS),
  ...Object.values(ATTENDANCE_EVENTS),
]) {
  eventBus.subscribe(type, 'command-center.overview-cache', () => overview.invalidate());
}

export const commandCenterModule: AppModule = { name: 'command-center', router: commandCenterRouter(overview) };
