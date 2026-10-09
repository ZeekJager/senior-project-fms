import type { RequestUser } from '../../../types/express';

/** Who is asking, for scope, audit and events. */
export interface Caller {
  user: RequestUser;
  correlationId: string;
}
