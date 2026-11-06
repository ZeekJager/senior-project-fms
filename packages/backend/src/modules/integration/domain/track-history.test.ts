import { describe, expect, it } from 'vitest';
import { trackWindow, TRACK_MAX_RANGE_DAYS } from './track-history';

const DAY = 24 * 3600_000;
const NOW = new Date('2026-11-06T12:00:00Z');
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe('trackWindow (FMS-95)', () => {
  it('without bounds, the 30 days to now', () => {
    expect(TRACK_MAX_RANGE_DAYS).toBe(30);
    expect(trackWindow(null, null, NOW)).toEqual({ from: at(-30), to: NOW });
  });

  it('from alone ends 30 days later, or now when that is sooner', () => {
    expect(trackWindow(at(-90), null, NOW)).toEqual({ from: at(-90), to: at(-60) });
    expect(trackWindow(at(-5), null, NOW)).toEqual({ from: at(-5), to: NOW });
  });

  it('to alone starts 30 days before it', () => {
    expect(trackWindow(null, at(-10), NOW)).toEqual({ from: at(-40), to: at(-10) });
  });

  it('exactly 30 days is read; 31 is refused, as is to not after from', () => {
    expect(trackWindow(at(-30), NOW, NOW)).toEqual({ from: at(-30), to: NOW });
    expect(() => trackWindow(at(-31), NOW, NOW)).toThrow(expect.objectContaining({ status: 400, code: 'VALIDATION_INVALID_DATE_RANGE', details: [{ field: 'to', reason: 'range_too_long' }] }));
    expect(() => trackWindow(NOW, NOW, NOW)).toThrow(expect.objectContaining({ details: [{ field: 'to', reason: 'before_from' }] }));
  });
});
