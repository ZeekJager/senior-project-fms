import { describe, expect, test } from 'vitest';
import { EDIT_WINDOW_MS, abilities, canEdit, retentionCutoff, unacknowledgedTooLong, type FeedbackState } from './feedback';

// FMS-158: the rules of driver feedback; the API and storage are in test/integration/driver-feedback.test.ts.

const given = new Date('2026-11-20T08:00:00.000Z');
const item = (over: Partial<FeedbackState> = {}): FeedbackState => ({
  authorId: '7',
  editableUntil: new Date(given.getTime() + EDIT_WINDOW_MS),
  retractedAt: null,
  acknowledgedAt: null,
  repliedAt: null,
  ...over,
});
const at = (hours: number) => new Date(given.getTime() + hours * 3_600_000);

describe('correcting feedback', () => {
  test('its author may edit it for 24 hours, nobody else, and never once retracted', () => {
    expect(canEdit(item(), '7', at(23.9))).toBe(true);
    expect(canEdit(item(), '7', at(24))).toBe(false);
    expect(canEdit(item(), '8', at(1))).toBe(false);
    expect(canEdit(item(), null, at(1))).toBe(false);
    expect(canEdit(item({ retractedAt: at(1) }), '7', at(2))).toBe(false);
  });
});

describe('what each side may do', () => {
  const manager = { manager: true, canWrite: true, driver: false, userId: '7' };
  const reader = { manager: true, canWrite: false, driver: false, userId: '9' };
  const driver = { manager: false, canWrite: false, driver: true, userId: '3' };

  test('a manager edits (author, in time) and retracts; a reader does neither', () => {
    expect(abilities(item(), manager, at(1))).toEqual({ edit: true, retract: true, acknowledge: false, reply: false, disagree: false });
    expect(abilities(item(), manager, at(25))).toMatchObject({ edit: false, retract: true });
    expect(abilities(item(), reader, at(1))).toMatchObject({ edit: false, retract: false });
    expect(abilities(item({ retractedAt: at(2) }), manager, at(3))).toMatchObject({ edit: false, retract: false });
  });

  test('the driver acknowledges once, replies once and may disagree while it is live', () => {
    expect(abilities(item(), driver, at(1))).toEqual({ edit: false, retract: false, acknowledge: true, reply: true, disagree: true });
    expect(abilities(item({ acknowledgedAt: at(2), repliedAt: at(2) }), driver, at(3))).toMatchObject({ acknowledge: false, reply: false, disagree: true });
    expect(abilities(item({ retractedAt: at(2) }), driver, at(3))).toMatchObject({ acknowledge: false, reply: false, disagree: false });
  });
});

describe('unacknowledged for 7 days', () => {
  test('flagged from 7 days after it was given, unless acknowledged or retracted', () => {
    const row = { createdAt: given, acknowledgedAt: null, retractedAt: null };
    expect(unacknowledgedTooLong(row, at(7 * 24 - 1))).toBe(false);
    expect(unacknowledgedTooLong(row, at(7 * 24))).toBe(true);
    expect(unacknowledgedTooLong({ ...row, acknowledgedAt: at(1) }, at(200))).toBe(false);
    expect(unacknowledgedTooLong({ ...row, retractedAt: at(1) }, at(200))).toBe(false);
  });
});

describe('the retention cutoff', () => {
  test('the same day so many months before, or that month’s last day', () => {
    expect(retentionCutoff(new Date('2026-11-25T03:40:00.000Z'), 24).toISOString()).toBe('2024-11-25T03:40:00.000Z');
    expect(retentionCutoff(new Date('2026-03-31T03:40:00.000Z'), 1).toISOString()).toBe('2026-02-28T03:40:00.000Z');
    expect(retentionCutoff(new Date('2028-03-31T03:40:00.000Z'), 1).toISOString()).toBe('2028-02-29T03:40:00.000Z');
    expect(retentionCutoff(new Date('2026-01-15T00:00:00.000Z'), 13).toISOString()).toBe('2024-12-15T00:00:00.000Z');
  });
});
