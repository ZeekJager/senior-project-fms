import { describe, expect, test } from 'vitest';
import { DEFAULT_DELAY_MARGINS, stepDelay, type DelayState } from './delay';

const END = new Date('2026-11-11T12:00:00Z');
const at = (minutes: number) => new Date(END.getTime() + minutes * 60_000);
const within: DelayState = { level: null, episode: 0 };
const step = (state: DelayState, minutesLate: number) => stepDelay(state, at(minutesLate), END, DEFAULT_DELAY_MARGINS);

describe('the trip delay rule (FMS-147)', () => {
  test('within the margin, or exactly on it, a trip is not late', () => {
    for (const minutes of [-30, 0, 14, 15]) expect(step(within, minutes)).toMatchObject({ state: within, raise: null });
  });

  test('past the margin, a trip within it falls late: a new episode, alerted', () => {
    expect(step(within, 16)).toEqual({ state: { level: 'late', episode: 1 }, raise: 'late', lateByMinutes: 16 });
  });

  test('a late trip later still is not alerted again', () => {
    expect(step({ level: 'late', episode: 1 }, 40)).toEqual({ state: { level: 'late', episode: 1 }, raise: null, lateByMinutes: 40 });
  });

  test('past the second margin, a late trip becomes urgent in the same episode', () => {
    expect(step({ level: 'late', episode: 1 }, 61)).toEqual({ state: { level: 'urgent', episode: 1 }, raise: 'urgent', lateByMinutes: 61 });
  });

  test('a trip first judged past the second margin is urgent at once', () => {
    expect(step({ level: null, episode: 2 }, 90)).toEqual({ state: { level: 'urgent', episode: 3 }, raise: 'urgent', lateByMinutes: 90 });
  });

  test('an urgent trip between the margins stays urgent, without an alert', () => {
    expect(step({ level: 'urgent', episode: 1 }, 30)).toMatchObject({ state: { level: 'urgent', episode: 1 }, raise: null });
  });

  test('back within the margin it recovers, and falling late again is a new episode', () => {
    const recovered = step({ level: 'urgent', episode: 1 }, 10);
    expect(recovered).toMatchObject({ state: { level: null, episode: 1 }, raise: null });
    expect(step(recovered.state, 20)).toMatchObject({ state: { level: 'late', episode: 2 }, raise: 'late' });
  });

  test('the margins are the depot’s', () => {
    expect(stepDelay(within, at(16), END, { lateMinutes: 30, urgentMinutes: 90 }).raise).toBeNull();
    expect(stepDelay(within, at(31), END, { lateMinutes: 30, urgentMinutes: 90 }).raise).toBe('late');
  });

  test('minutes late are whole minutes, rounded down; an early trip is negative', () => {
    expect(stepDelay(within, new Date(END.getTime() + 16.9 * 60_000), END, DEFAULT_DELAY_MARGINS).lateByMinutes).toBe(16);
    expect(step(within, -5).lateByMinutes).toBe(-5);
  });
});
