import { describe, expect, test } from 'vitest';
import { SESSION_STATUSES, SESSION_TRANSITIONS, canMove, illegalTransition, isFinal } from './ev';

// FMS-96: the charging session's state machine.

describe('charging session state machine', () => {
  test('planned starts or is cancelled; charging completes or fails', () => {
    expect(SESSION_TRANSITIONS).toEqual({
      planned: ['in_progress', 'cancelled'],
      in_progress: ['completed', 'failed'],
      completed: [],
      failed: [],
      cancelled: [],
    });
  });

  test('every other move is refused, and completed, failed and cancelled are final', () => {
    const allowed = new Set(['planned>in_progress', 'planned>cancelled', 'in_progress>completed', 'in_progress>failed']);
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        if (from === to) continue;
        expect(canMove(from, to), `${from} → ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
    expect(SESSION_STATUSES.filter(isFinal)).toEqual(['completed', 'failed', 'cancelled']);
  });

  test('a refused move is 409 with where the session can go', () => {
    const err = illegalTransition('planned', 'completed');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT_INVALID_STATE_TRANSITION');
    expect(err.details).toEqual([{ field: 'status', reason: 'planned_to_completed', allowed_transitions: ['in_progress', 'cancelled'] }]);
  });
});
