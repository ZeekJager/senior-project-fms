import { createHash, randomUUID } from 'node:crypto';

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

/**
 * `id`: pass a `deterministicEventId` when the same fact may be published
 * more than once (a scheduled job that reruns), so consumers, which are
 * idempotent by event id, process it once.
 */
export function createEvent<P extends Record<string, unknown>>(
  type: string,
  payload: P,
  ctx: EventContext,
  options: { version?: number; id?: string } = {},
): DomainEvent<P> {
  return {
    id: options.id ?? randomUUID(),
    type,
    version: options.version ?? 1,
    occurred_at: new Date().toISOString(),
    actor: ctx.actor,
    correlation_id: ctx.correlationId,
    payload,
  };
}

/** A UUID (version 5 layout) derived from `name`: the same fact always gets the same event id. */
export function deterministicEventId(name: string): string {
  const h = createHash('sha256').update(name).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
