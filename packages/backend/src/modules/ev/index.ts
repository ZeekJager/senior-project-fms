import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { AppModule } from '../../shared/module';
import { evRefs } from '../fleet';
import { evRouter } from './api/ev.routes';
import { EvService } from './application/ev.service';
import { EvRepository } from './infrastructure/ev.repository';

// EV fleet management (FMS-96, architecture §13, docs/ev.md): battery state, charging sessions and stations.
const service = new EvService({ ev: new EvRepository(pool), vehicles: evRefs.vehicles, events: eventBus });

const router = Router();
router.use(evRouter(service));

export const evModule: AppModule = { name: 'ev', router };
export { EV_EVENTS } from './domain/ev';
