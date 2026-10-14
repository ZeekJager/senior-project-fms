import type { OptionalDependency } from '../http/health';
import type { Queryable } from '../infrastructure/queryable';
import { outboxStore, type OutboxLag } from './outbox';

/** Events waiting longer than this make /health/ready say `degraded`. */
export const OUTBOX_LAG_DEGRADED_SECONDS = 60;

/**
 * The event outbox in /health/ready (FMS-73): `outbox: "degraded"` while an
 * event has waited a minute or more, or any has been dead-lettered (a
 * consumer failed it on every attempt: someone has to look). The API keeps
 * serving either way. `metrics()` is the lag itself.
 */
export function outboxHealth(db: Queryable): OptionalDependency & { metrics(): Promise<OutboxLag> } {
  return {
    state: () => 'ok',
    async ping() {
      const lag = await outboxStore.lag(db);
      if (lag.dead_lettered > 0) throw new Error(`${lag.dead_lettered} dead-lettered event(s)`);
      if (lag.oldest_pending_seconds >= OUTBOX_LAG_DEGRADED_SECONDS) throw new Error(`oldest pending event is ${lag.oldest_pending_seconds} s old`);
    },
    metrics: () => outboxStore.lag(db),
  };
}
