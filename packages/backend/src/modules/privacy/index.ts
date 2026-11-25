import { Router } from 'express';
import { config } from '../../config';
import { pool } from '../../db';
import type { AppModule } from '../../shared/module';
import { accountData } from '../auth';
import { driverFeedbackData } from '../analytics';
import { driverIncidentData } from '../alert';
import { driverData, trackingRefs } from '../fleet';
import { driverFuelData } from '../fuel';
import { driverLocationData } from '../integration';
import { driverTripData, tripPartiesByIds } from '../trip';
import { dataExportRouter } from './api/data-export.routes';
import { DataErasureService } from './application/data-erasure.service';
import { DataExportService } from './application/data-export.service';

// Driver data protection (FMS-104, docs/driver-data-protection.md): owns no schema. A person's own data export
// reads the modules that hold the records through their index.ts, like the command center.
const dataExport = new DataExportService({
  db: pool,
  pingRetentionDays: config.tracking.retention.pingDays,
  refs: {
    account: (db, userId) => accountData.forUser(db, userId),
    driver: (db, userId) => driverData.forUser(db, userId),
    trips: (db, driverId) => driverTripData.forDriver(db, driverId),
    fuelLogs: (db, driverId) => driverFuelData.forDriver(db, driverId),
    incidents: (db, driverId, userId) => driverIncidentData.forPerson(db, driverId, userId),
    pings: (db, tripIds, limit) => driverLocationData.forTrips(db, tripIds, limit),
    vehicles: (db, ids) => trackingRefs.vehicles.refsByIds(db, ids),
    tripIds: (db, ids) => tripPartiesByIds(db, ids),
    feedback: (db, driverId) => driverFeedbackData.forDriver(db, driverId),
  },
});

// A driver's erasure (FMS-158): each module's personal data held for erasure, in one transaction. Today feedback.
const dataErasure = new DataErasureService({
  db: pool,
  drivers: { byPublicId: (db, publicId) => driverData.byPublicId(db, publicId) },
  erasers: [{ kind: 'feedback', erase: (client, ctx, driverId) => driverFeedbackData.erase(client, ctx, driverId) }],
});

const router = Router();
router.use(dataExportRouter(dataExport, dataErasure));

export const privacyModule: AppModule = { name: 'privacy', router };
