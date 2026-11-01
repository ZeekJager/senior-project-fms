import { describe, expect, test } from 'vitest';
import { attendanceCodeKey, isLate, issueCode, readCode } from './attendance-code';
import { checkManualTimes } from './attendance';

const key = attendanceCodeKey('s'.repeat(40));
const DEPOT = '1b4e28ba-2fa1-4d2b-883f-0016d3cca427';
const local = (iso: string) => new Date(`${iso}+03:00`);
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { details?: { reason: string }[] }).details?.[0]?.reason;
  }
  return 'accepted';
};

describe('the depot attendance code (FMS-141)', () => {
  const shownAt = new Date('2026-10-31T05:00:10Z');
  const issued = issueCode(key, DEPOT, shownAt);

  test('names the depot and a 30-second window, refreshed at its end, accepted for 60 s from its start', () => {
    expect(issued.code).toMatch(new RegExp(`^FMSA1\\.${DEPOT}\\.\\d+\\.[\\w-]{22}$`));
    expect(issued.issued_at).toEqual(new Date('2026-10-31T05:00:00Z'));
    expect(issued.refresh_at).toEqual(new Date('2026-10-31T05:00:30Z'));
    expect(issued.expires_at).toEqual(new Date('2026-10-31T05:01:00Z'));
    expect(readCode(key, issued.code, shownAt)).toEqual({ depotPublicId: DEPOT });
    expect(readCode(key, issued.code, new Date('2026-10-31T05:01:00Z'))).toEqual({ depotPublicId: DEPOT });
  });

  test('expires 60 s after its window began, and a window not yet begun is refused too', () => {
    expect(reason(() => readCode(key, issued.code, new Date('2026-10-31T05:01:00.001Z')))).toBe('expired');
    expect(reason(() => readCode(key, issued.code, new Date('2026-10-31T04:59:59Z')))).toBe('expired');
  });

  test('a changed depot, window or signature, another server’s key, or any other text is not a code', () => {
    const [prefix, , window, sig] = issued.code.split('.');
    const other = '9f1c2b7e-0d4a-4c5e-8b6a-3e2f1d0c9b8a';
    expect(reason(() => readCode(key, [prefix, other, window, sig].join('.'), shownAt))).toBe('invalid');
    expect(reason(() => readCode(key, [prefix, DEPOT, String(Number(window) + 1), sig].join('.'), shownAt))).toBe('invalid');
    expect(reason(() => readCode(key, `${issued.code.slice(0, -1)}${issued.code.endsWith('A') ? 'B' : 'A'}`, shownAt))).toBe('invalid');
    expect(reason(() => readCode(attendanceCodeKey('t'.repeat(40)), issued.code, shownAt))).toBe('invalid');
    expect(reason(() => readCode(key, 'https://example.com/check-in', shownAt))).toBe('invalid');
  });
});

describe('late (FMS-141)', () => {
  const depot = { workStartsAt: '08:00', lateAfterMinutes: 15 };
  test('after the start plus the grace, Addis Ababa time; on the minute is on time', () => {
    expect(isLate(local('2026-10-31T08:15:59'), depot)).toBe(false);
    expect(isLate(local('2026-10-31T08:16:00'), depot)).toBe(true);
    expect(isLate(local('2026-10-31T07:40:00'), depot)).toBe(false);
    expect(isLate(local('2026-10-31T06:31:00'), { workStartsAt: '06:00', lateAfterMinutes: 30 })).toBe(true);
  });
});

describe('times entered by hand (FMS-141)', () => {
  const now = local('2026-10-31T12:00:00');
  test('on the record’s day, not ahead of now, a check-out only after a check-in', () => {
    expect(reason(() => checkManualTimes('2026-10-31', { in: local('2026-10-31T07:50:00'), out: local('2026-10-31T11:00:00') }, now))).toBe('accepted');
    expect(reason(() => checkManualTimes('2026-10-31', { in: local('2026-10-30T23:50:00'), out: null }, now))).toBe('not_on_date');
    expect(reason(() => checkManualTimes('2026-10-31', { in: local('2026-10-31T13:00:00'), out: null }, now))).toBe('in_future');
    expect(reason(() => checkManualTimes('2026-10-31', { in: null, out: local('2026-10-31T11:00:00') }, now))).toBe('without_check_in');
    expect(reason(() => checkManualTimes('2026-10-31', { in: local('2026-10-31T09:00:00'), out: local('2026-10-31T08:00:00') }, now))).toBe('before_check_in');
  });
});
