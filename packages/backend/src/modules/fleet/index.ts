import type { AppModule } from '../../shared/module';
import { fleetRouter } from './api/fleet.routes';

export const fleetModule: AppModule = { name: 'fleet', router: fleetRouter };
