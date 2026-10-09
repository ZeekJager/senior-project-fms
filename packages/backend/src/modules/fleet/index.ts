import { pool } from '../../db';
import type { AppModule } from '../../shared/module';
import type { DepotDirectory } from '../auth';
import { fleetRouter } from './api/fleet.routes';
import { findDepotPublicId } from './infrastructure/depot.queries';

export const fleetModule: AppModule = { name: 'fleet', router: fleetRouter };

/** Depot lookups other modules need; the auth module uses it for /auth/me. */
export const depotDirectory: DepotDirectory = {
  publicIdOf: (depotId) => findDepotPublicId(pool, depotId),
};
