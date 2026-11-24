import { describe, expect, test } from 'vitest';
import {
  addWorkingDays,
  assertCan,
  canDo,
  correctionsFor,
  median,
  monthEnd,
  sniffAttachment,
  targetKey,
  withinWindow,
  type AppealAction,
  type AppealStatus,
} from './appeal';

describe('the status flow', () => {
  const steps: [AppealStatus, AppealAction, boolean][] = [
    ['submitted', 'claim', true],
    ['under_review', 'claim', false],
    ['submitted', 'decide', false],
    ['under_review', 'decide', true],
    ['approved', 'decide', false],
    ['submitted', 'withdraw', true],
    ['under_review', 'withdraw', true],
    ['approved', 'withdraw', false],
    ['rejected', 'acknowledge', true],
    ['under_review', 'acknowledge', false],
    ['closed', 'comment', false],
    ['under_review', 'comment', true],
    ['approved', 'close', true],
    ['closed', 'close', false],
  ];
  test.each(steps)('%s, %s: %s', (status, action, allowed) => {
    expect(canDo(status, action)).toBe(allowed);
  });

  test('a step not in the flow is 409 invalid_transition', () => {
    expect(() => assertCan('closed', 'decide')).toThrow(expect.objectContaining({ status: 409, code: 'CONFLICT_INVALID_STATE_TRANSITION' }));
  });
});

describe('corrections', () => {
  test('a flag or incident is excluded on its own, or with its trip when it was on one; a score appeal names what it corrects', () => {
    expect(correctionsFor('flag', true)).toEqual(['exclude_flag', 'exclude_trip']);
    expect(correctionsFor('flag', false)).toEqual(['exclude_flag']);
    expect(correctionsFor('incident', false)).toEqual(['exclude_incident']);
    expect(correctionsFor('score', false)).toEqual(['exclude_flag', 'exclude_incident', 'exclude_trip']);
  });
});

test('one open appeal per flag, incident and driver month', () => {
  expect(targetKey({ type: 'flag', id: '7' })).toBe('flag:7');
  expect(targetKey({ type: 'score', driverId: '3', month: '2026-10' })).toBe('score:3:2026-10');
});

describe('the appeal window', () => {
  const at = new Date('2026-11-01T08:00:00Z');
  test('30 days after the event is still in; a minute more is out', () => {
    expect(withinWindow(at, new Date(at.getTime() + 30 * 86_400_000), 30)).toBe(true);
    expect(withinWindow(at, new Date(at.getTime() + 30 * 86_400_000 + 60_000), 30)).toBe(false);
  });
  test('a month is appealed from its end in Addis Ababa', () => {
    expect(monthEnd('2026-10').toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(monthEnd('2026-12').toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });
});

describe('the review deadline in working days', () => {
  // 2026-11-23 is a Monday.
  test('5 working days from a Monday is the next Monday, same time', () => {
    expect(addWorkingDays(new Date('2026-11-23T07:00:00Z'), 5).toISOString()).toBe('2026-11-30T07:00:00.000Z');
  });
  test('from a Thursday it skips the weekend', () => {
    expect(addWorkingDays(new Date('2026-11-26T07:00:00Z'), 2).toISOString()).toBe('2026-11-30T07:00:00.000Z');
  });
  test('sent on Saturday, counting starts on Monday', () => {
    expect(addWorkingDays(new Date('2026-11-28T07:00:00Z'), 1).toISOString()).toBe('2026-11-30T07:00:00.000Z');
  });
  test('the weekday is Addis Ababa’s: Friday 22:30 UTC is already Saturday there', () => {
    // Saturday 01:30 local; one working day on is Monday 01:30 local, Sunday 22:30 UTC.
    expect(addWorkingDays(new Date('2026-11-27T22:30:00Z'), 1).toISOString()).toBe('2026-11-29T22:30:00.000Z');
  });
});

test('attachments are recognised by their first bytes', () => {
  expect(sniffAttachment(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  expect(sniffAttachment(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
  expect(sniffAttachment(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('image/webp');
  expect(sniffAttachment(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  expect(sniffAttachment(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  expect(sniffAttachment(Buffer.from('GIF89a'))).toBeNull();
});

test('median', () => {
  expect(median([])).toBeNull();
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 2, 3])).toBe(2.5);
});
