import { AppError } from '../../../shared/errors/app-error';
import type { TripStatus } from './trip';

// Flexible dispatch (FMS-139, docs/flexible-dispatch.md): times that move after assignment, and the trips a move
// runs into, shifted later instead of a dead end. A driver or vehicle is still never on two trips at once
// (ex_trip_driver_overlap and ex_trip_vehicle_overlap, touching ends included since migration 030).

/** A trip's window as the schedule sees it (internal ids). */
export interface Slot {
  id: string;
  publicId: string;
  driverId: string | null;
  vehicleId: string | null;
  status: TripStatus;
  start: Date;
  end: Date;
}

/** A trip pushed later starts this long after the one it ran into ends: ends that touch are an overlap. */
export const TURNAROUND_MS = 60_000;

/** At most this many trips move with one change; a longer chain is refused rather than half done. */
export const MAX_SHIFTED = 20;

/** Statuses whose times a dispatcher may change; an en-route trip only its end. */
export const RESCHEDULABLE_STATUSES: readonly TripStatus[] = ['draft', 'scheduled', 'assigned', 'en_route'];

/** A trip that has a driver or a vehicle waiting on its times: a change needs a reason, and moves the clashes. */
export const STAFFED_STATUSES: readonly TripStatus[] = ['assigned', 'en_route'];

/** How far `next` must move so it starts a turnaround after `end`; 0 when it already does. */
export function shiftNeeded(end: Date, nextStart: Date): number {
  return Math.max(0, end.getTime() + TURNAROUND_MS - nextStart.getTime());
}

/** The trip moved later by `ms`, its length kept. */
export function shiftedBy(slot: Slot, ms: number): Slot {
  return { ...slot, start: new Date(slot.start.getTime() + ms), end: new Date(slot.end.getTime() + ms) };
}

/** Whole minutes, rounded up: what a dispatcher is offered to shift by. */
export const minutesOf = (ms: number) => Math.ceil(ms / 60_000);

/**
 * The change runs into another trip of the same driver or vehicle. `shiftable`: that trip is assigned and
 * starts later, so `shift_following` can move it `shift_minutes` later; otherwise the change itself must give way.
 */
export function scheduleClash(field: 'driver_id' | 'vehicle_id', other: Slot, shiftMs: number, shiftable: boolean): AppError {
  const code = field === 'driver_id' ? 'CONFLICT_DRIVER_OVERLAP' : 'CONFLICT_VEHICLE_OVERLAP';
  const message = field === 'driver_id' ? 'The driver is already on a trip at that time.' : 'The vehicle is already on a trip at that time.';
  return new AppError(409, code, message, [
    { field, reason: 'overlapping_trip', record_id: other.publicId, shiftable, ...(shiftable ? { shift_minutes: minutesOf(shiftMs) } : {}) },
  ]);
}

export const tooManyShifted = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `Moving the following trips would move more than ${MAX_SHIFTED}. Change fewer trips at once.`, [
    { field: 'scheduled_end', reason: 'too_many_trips_to_shift' },
  ]);

export const reasonRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Say why the times change: it is kept with the change.', [{ field: 'reason', reason: 'required' }]);

export const startFixed = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The trip is under way: only its end can change.', [{ field: 'scheduled_start', reason: 'trip_under_way' }]);

export const adhocDepotRequired = (given: boolean) =>
  new AppError(400, 'VALIDATION_FAILED', given ? 'The depot does not exist or is outside your depots.' : 'Choose the depot the trip leaves from.', [
    { field: 'depot_id', reason: given ? 'references_missing_record' : 'required' },
  ]);

export const endRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Give an end time: the route has no estimated time.', [{ field: 'scheduled_end', reason: 'required' }]);
