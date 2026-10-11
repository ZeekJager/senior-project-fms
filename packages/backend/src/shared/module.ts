import type { Router } from 'express';
import type { ScheduledJob } from './jobs/job';

/**
 * What a module exposes to the composition root. Other modules may import
 * only a module's `index.ts`, never its layers (§32, enforced by FMS-12).
 */
export interface AppModule {
  name: string;
  /** Mounted under `/api/v1`. */
  router?: Router;
  /** Run once a day by the server's scheduler (src/server.ts), once across instances; not by tests or scripts. */
  jobs?: ScheduledJob[];
}
