import { Router } from 'express';
import { config } from '../../config';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { alertRefs, incidentRefs } from '../fleet';
import { notificationGateway } from '../integration';
import { tripLookups } from '../trip';
import { alertRouter } from './api/alert.routes';
import { incidentRouter } from './api/incident.routes';
import { notificationRouter } from './api/notification.routes';
import { AlertService } from './application/alert.service';
import { DeliveryService } from './application/delivery.service';
import { IncidentService } from './application/incident.service';
import { InboxService } from './application/inbox.service';
import type { IncidentType } from './domain/incident';
import { ALERT_RULES } from './domain/rules';
import { AlertRepository } from './infrastructure/alert.repository';
import { DeliveryRepository } from './infrastructure/delivery.repository';
import { IncidentRepository } from './infrastructure/incident.repository';
import { NotificationRepository } from './infrastructure/notification.repository';
import { driverIncidentsExport } from './infrastructure/driver-incidents-export.queries';

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

// Alerts by email, SMS and push (FMS-93): queued with the alert, sent through the integration gateway by the
// delivery job. Only this module reads the recipients' email addresses and phone numbers.
const delivery = new DeliveryService({
  repo: new DeliveryRepository(pool),
  gateway: notificationGateway,
  users: {
    accounts: async (db, ids) =>
      new Map(
        (await userDirectory.findByIds(db, ids)).map((u) => [u.id, { publicId: u.publicId, fullName: u.fullName, email: u.email, phone: u.phone, active: u.status === 'active' }]),
      ),
  },
  alerts: repo,
  appUrl: config.app.publicUrl,
});

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
  delivery,
  escalationMinutes: config.alerts.escalationMinutes,
});

const incidentRepository = new IncidentRepository(pool);
const incidentService = new IncidentService({
  incidents: incidentRepository,
  refs: {
    ...incidentRefs,
    trips: { find: tripLookups.find, publicIds: tripLookups.publicIds },
    users: {
      accounts: async (db, ids) => new Map((await userDirectory.findByIds(db, ids)).map((u) => [u.id, { publicId: u.publicId, fullName: u.fullName }])),
      activeHolder: (db, publicId, permission) => userDirectory.activeHolder(db, publicId, permission),
    },
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
router.use(alertRouter(service, delivery));
router.use(incidentRouter(incidentService));
router.use(notificationRouter(inbox, delivery));

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
    {
      // Emails, SMS and pushes that are due (FMS-93): new ones, and retries of failed attempts (1, 5, 15, 60 minutes).
      name: 'notification-delivery',
      every: 1,
      leaseMs: 5 * 60_000,
      run: async ({ now, correlationId }) => ({ ...(await delivery.drain({ now, correlationId })) }),
    },
  ],
};

/** For tests: send the emails, SMS and pushes due by `now`, as the delivery job does. */
export const notificationDelivery = {
  drain: (now: Date, correlationId: string) => delivery.drain({ now, correlationId }),
};

/** For tests and the escalation job's callers: run escalation as of `now`. */
export const alertEngine = {
  escalate: (now: Date, correlationId: string) => service.escalate({ now, correlationId }),
};

/** For the command center's overview (FMS-89): a depot's (internal id) or every depot's (null) active alerts and incidents. */
export const commandCenterFeed = {
  alerts: (depotId: string | null, limit: number) => service.active(depotId, limit),
  incidents: (depotId: string | null, limit: number) => incidentService.active(depotId, limit),
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

/** For a driver's data export (FMS-104): incident reports about them or filed by their account. */
export const driverIncidentData = { forPerson: (db: Queryable, driverId: string | null, userId: string) => driverIncidentsExport(db, driverId, userId) };
export type { DriverIncidentExport } from './infrastructure/driver-incidents-export.queries';
