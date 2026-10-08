import type { DbMutate } from '../middleware/auditLog';

/**
 * The caller. Anonymous until the auth module's `authenticate` middleware
 * (FMS-05) resolves the access cookie. Ids are BIGINTs, which node-pg
 * returns as strings; `id` and `depotId` are internal and never sent to
 * clients (use `publicId`).
 */
export interface RequestUser {
  id: string | null;
  publicId: string | null;
  roles: string[];
  /** `resource:action` codes from the user's roles (api-contract §5.1). */
  permissions: string[];
  /** Home depot; null for depot-unscoped users such as admin. */
  depotId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      user?: RequestUser;
      dbMutate: DbMutate;
    }
  }
}
