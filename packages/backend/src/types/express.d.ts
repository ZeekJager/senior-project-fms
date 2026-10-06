import type { DbMutate } from '../middleware/auditLog';

export interface RequestUser {
  id: number | null;
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
