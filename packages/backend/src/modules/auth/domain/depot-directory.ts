import type { Queryable } from '../../../shared/infrastructure/queryable';

/**
 * What auth needs from the fleet module: the public id of a user's home
 * depot (for /auth/me and user views), and the internal id of a live depot
 * named by its public id (user administration). auth may not query
 * fleet.depots (FMS-12, CONVENTIONS.md Modules rule 3) and may not import the
 * fleet module either, because fleet imports auth's `authorize`. So fleet
 * implements this and src/modules/index.ts (the composition root) hands it to
 * auth with `provideDepotDirectory`.
 */
export interface DepotDirectory {
  /** The depot's public_id, or null if no depot has this internal id. */
  publicIdOf(depotId: string): Promise<string | null>;
  /**
   * The internal id of an active depot, or null. Pass the caller's
   * transaction client as `db`: the depot row is share-locked, so it cannot
   * be deleted while a user is being assigned to it.
   */
  resolveActive(publicId: string, db?: Queryable): Promise<string | null>;
}
