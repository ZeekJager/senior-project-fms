import type { Router } from 'express';

/**
 * What a module exposes to the composition root. Other modules may import
 * only a module's `index.ts`, never its layers (§32, enforced by FMS-12).
 */
export interface AppModule {
  name: string;
  /** Mounted under `/api/v1`. */
  router?: Router;
}
