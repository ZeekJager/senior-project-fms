import { Router } from 'express';
import { config } from '../../config';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { alertRefs, incidentRefs } from '../fleet';
import { tripLookups } from '../trip';
import { alertRouter } from './api/alert.routes';
import { incidentRouter } from './api/incident.routes';
import { notificationRouter } from './api/notification.routes';
import { AlertService } from './application/alert.service';
import { IncidentService } from './application/incident.service';
import { InboxService } from './application/inbox.service';
import type { IncidentType } from './domain/incident';
import { ALERT_RULES } from './domain/rules';
import { AlertRepository } from './infrastructure/alert.repository';
import { IncidentRepository } from './infrastructure/incident.repository';
import { NotificationRepository } from './infrastructure/notification.repository';

// The alert engine (FMS-92, architecture §9.4 and §34): events become alerts by rule, de-duplicated per
// source, notified in-app, acknowledged and resolved through the API, and escalated when a critical
// alert is left unacknowledged. See docs/alerts.md. Incident reports (FMS-38) live here too: they are
// alert.incident_reports, and a critical one becomes an alert through IncidentReported.

const userPublicIds = async (db: Queryable, ids: readonly string[]) => new Map((await userDirectory.findByIds(db, ids)).map((u) => [u.id, u.publicId]));

// The in-app inbox (FMS-48): the alert engine writes the notifications and announces each recipient's new unread count.
const inbox = new InboxService({
  notifications: new NotificationRepository(pool),
  users: { publicIds: userPublicIds },
  vehicles: alertRefs.vehicles,
  drivers: alertRefs.drivers,
  events: eventBus,
});

const repo = new AlertRepository(pool);
const service = new AlertService({
  repo,
  refs: {
    vehicles: alertRefs.vehicles,
    drivers: alertRefs.drivers,
    depots: alertRefs.depots,
    trips: { idsByPublicIds: tripLookups.idsByPublicIds, publicIds: tripLookups.publicIds },
    users: {
      activeWithRoles: (db, roles, depotId, unscoped) => userDirectory.activeWithRoles(db, roles, depotId, unscoped),
      publicIds: userPublicIds,
    },
  },
  events: eventBus,
  inbox,
  escalationMinutes: config.alerts.escalationMinutes,
});

const incidentRepository = new IncidentRepository(pool);
const incidentService = new IncidentService({
  incidents: incidentRepository,
  refs: {
    ...incidentRefs,
    trips: { find: tripLookups.find, publicIds: tripLookups.publicIds },
    users: { publicIds: userPublicIds },
  },
  events: eventBus,
});

// Every event with a rule, on the consumer's transaction: the alert and its notifications commit with
// the record that the event was handled, so a redelivery is skipped, never a second alert.
for (const type of Object.keys(ALERT_RULES)) {
  eventBus.subscribe(type, 'alert.engine', async (event, tx) => {
    await service.raise(tx, event);
  });
}

const router = Router();
router.use(alertRouter(service));
router.use(incidentRouter(incidentService));
router.use(notificationRouter(inbox));

export const alertModule: AppModule = {
  name: 'alert',
  router,
  jobs: [
    {
      // Critical alerts nobody has acknowledged go to the next tier (ALERT_ESCALATION_MINUTES, default 15).
      name: 'alert-escalation',
      every: 1,
      leaseMs: 5 * 60_000,
      run: ({ now, correlationId }) => service.escalate({ now, correlationId }),
    },
  ],
};

/** For tests and the escalation job's callers: run escalation as of `now`. */
export const alertEngine = {
  escalate: (now: Date, correlationId: string) => service.escalate({ now, correlationId }),
};

/**
 * For maintenance (FMS-125): the incident a failure came from, by public id, with its vehicle (internal
 * ids), and incidents' public ids for responses. The caller checks the vehicle is the failure's own.
 */
export const incidentLookup = {
  find: (db: Queryable, publicId: string) => incidentRepository.refByPublicId(db, publicId),
  publicIds: (db: Queryable, ids: readonly string[]) => incidentRepository.publicIds(db, ids),
  /** For the nightly scoring (FMS-55): each vehicle's incidents of these types in [from, to), by internal id. */
  countsByVehicle: (db: Queryable, vehicleIds: readonly string[], types: readonly IncidentType[], from: Date, to: Date) =>
    incidentRepository.countsByVehicle(db, vehicleIds, types, from, to),
};

export { ALERT_EVENTS, SEVERITIES as ALERT_SEVERITIES, type AlertView } from './domain/alert';
export { INCIDENT_EVENTS, INCIDENT_TYPES, type IncidentView } from './domain/incident';
export { ALERT_RULES, ESCALATION_TIERS } from './domain/rules';
