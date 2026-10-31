import { describe, expect, test } from 'vitest';
import { FEEDBACK_EDIT_DAYS, editableUntil, precisionOf } from './prediction-feedback';

describe('precisionOf (FMS-128)', () => {
  test('is the confirmed share of the judged predictions, to three decimals', () => {
    expect(precisionOf(2, 4)).toBe(0.5);
    expect(precisionOf(1, 3)).toBe(0.333);
    expect(precisionOf(2, 3)).toBe(0.667);
    expect(precisionOf(0, 5)).toBe(0);
    expect(precisionOf(5, 5)).toBe(1);
  });

  test('is null, not 0, when nothing has been judged: no figure is not a bad figure', () => {
    expect(precisionOf(0, 0)).toBeNull();
  });
});

describe('editableUntil', () => {
  test('is 7 days after the feedback was given', () => {
    expect(FEEDBACK_EDIT_DAYS).toBe(7);
    expect(editableUntil(new Date('2026-10-20T08:00:00Z')).toISOString()).toBe('2026-10-27T08:00:00.000Z');
  });
});
