import type { Router } from 'express';
import type { ScheduledJob } from './jobs/job';

/** A table a module derives from another source (a read model), and how to rebuild it from that source. */
export interface ReadModel {
  /** The table, `<schema>.<table>`, for logs. */
  name: string;
  /** Rebuilds it from its source and says what changed (counts). Safe to run at any time. */
  rebuild(): Promise<Record<string, unknown>>;
}

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
  /**
   * Derived tables the module keeps from events. Anything that writes their
   * source without its events (the seed, a bulk import, a restore) calls
   * rebuildReadModels() (modules/index.ts) afterwards.
   */
  readModels?: ReadModel[];
}
