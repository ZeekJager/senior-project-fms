import { randomUUID } from 'node:crypto';

/**
 * The event envelope from CONVENTIONS.md (Events). `type` is a past-tense
 * fact (`VehicleRetired`); the payload carries ids, never personal data.
 */
export interface DomainEvent<P extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: string;
  version: number;
  occurred_at: string;
  /** The acting user's public id, or null for the system. */
  actor: string | null;
  correlation_id: string;
  payload: P;
}

export interface EventContext {
  actor: string | null;
  correlationId: string;
}

export function createEvent<P extends Record<string, unknown>>(
  type: string,
  payload: P,
  ctx: EventContext,
  version = 1,
): DomainEvent<P> {
  return {
    id: randomUUID(),
    type,
    version,
    occurred_at: new Date().toISOString(),
    actor: ctx.actor,
    correlation_id: ctx.correlationId,
    payload,
  };
}
