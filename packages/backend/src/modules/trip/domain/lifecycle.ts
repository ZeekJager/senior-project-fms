import { AppError } from '../../../shared/errors/app-error';
import type { TripStatus } from './trip';

/**
 * The trip lifecycle (FMS-32): draft → scheduled → assigned → en_route →
 * completed, and cancelled from draft, scheduled or assigned. Completed and
 * cancelled are terminal. Every status change goes through this table.
 */
export const TRIP_TRANSITIONS: Record<TripStatus, readonly TripStatus[]> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['assigned', 'cancelled'],
  assigned: ['en_route', 'cancelled'],
  en_route: ['completed'],
  completed: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly TripStatus[] = ['completed', 'cancelled'];

export function canMove(from: TripStatus, to: TripStatus): boolean {
  return TRIP_TRANSITIONS[from].includes(to);
}

/** Statuses POST /trips/{id}/status takes: any status a trip can move to (never draft). */
export const COMMAND_STATUSES = ['scheduled', 'assigned', 'en_route', 'completed', 'cancelled'] as const satisfies readonly TripStatus[];
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** 409 with where the trip can go from here, so a client can offer the right action. */
export const invalidTripTransition = (from: TripStatus, to: TripStatus) =>
  new AppError(
    409,
    'CONFLICT_INVALID_STATE_TRANSITION',
    TRIP_TRANSITIONS[from].length === 0 ? `A ${from.replace('_', ' ')} trip cannot change any more.` : `A ${from.replace('_', ' ')} trip cannot become ${to.replace('_', ' ')}.`,
    [{ field: 'status', reason: `${from}_to_${to}`, allowed_transitions: [...TRIP_TRANSITIONS[from]] }],
  );

/** scheduled → assigned is the assignment itself: it needs a driver and vehicle and the BR rules (FMS-31). */
export const assignRequired = (from: TripStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'Assign a driver and vehicle with POST /trips/{id}/assign.', [
    { field: 'status', reason: 'assign_required', allowed_transitions: [...TRIP_TRANSITIONS[from]] },
  ]);

/** A draft becomes scheduled only with both times (PATCH them first). */
export const scheduleRequired = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'Set the trip’s start and end before scheduling it.', [
    { field: 'status', reason: 'schedule_required', allowed_transitions: [...TRIP_TRANSITIONS.draft] },
  ]);

/** Scheduling a draft and cancelling are dispatch decisions: trip:write, which drivers do not have. */
export const dispatchOnly = () => new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Only dispatch can schedule or cancel a trip.');
