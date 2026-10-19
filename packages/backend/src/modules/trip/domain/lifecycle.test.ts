import { describe, expect, test } from 'vitest';
import { AppError } from '../../../shared/errors/app-error';
import { COMMAND_STATUSES, TERMINAL_STATUSES, TRIP_TRANSITIONS, canMove, invalidTripTransition } from './lifecycle';
import { TRIP_STATUSES, type TripStatus } from './trip';

/** The card's lifecycle, written out move by move. */
const ALLOWED: [TripStatus, TripStatus][] = [
  ['draft', 'scheduled'],
  ['draft', 'cancelled'],
  ['scheduled', 'assigned'],
  ['scheduled', 'cancelled'],
  ['assigned', 'en_route'],
  ['assigned', 'cancelled'],
  ['en_route', 'completed'],
];

describe('trip lifecycle (FMS-32)', () => {
  test.each(TRIP_STATUSES.flatMap((from) => TRIP_STATUSES.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
    expect(canMove(from, to)).toBe(ALLOWED.some(([a, b]) => a === from && b === to));
  });

  test('completed and cancelled are terminal', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed']);
    for (const status of TERMINAL_STATUSES) expect(TRIP_TRANSITIONS[status]).toEqual([]);
  });

  test('a trip under way cannot be cancelled, only completed', () => {
    expect(TRIP_TRANSITIONS.en_route).toEqual(['completed']);
  });

  test('nothing moves back to draft, and /status offers every other status', () => {
    expect(Object.values(TRIP_TRANSITIONS).some((targets) => targets.includes('draft'))).toBe(false);
    expect([...COMMAND_STATUSES].sort()).toEqual(TRIP_STATUSES.filter((s) => s !== 'draft').sort());
  });

  test('an invalid move is 409 with the reason and the moves allowed from where the trip is', () => {
    const err = invalidTripTransition('scheduled', 'en_route');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 409,
      code: 'CONFLICT_INVALID_STATE_TRANSITION',
      details: [{ field: 'status', reason: 'scheduled_to_en_route', allowed_transitions: ['assigned', 'cancelled'] }],
    });
    expect(invalidTripTransition('completed', 'en_route').details).toEqual([{ field: 'status', reason: 'completed_to_en_route', allowed_transitions: [] }]);
  });
});
