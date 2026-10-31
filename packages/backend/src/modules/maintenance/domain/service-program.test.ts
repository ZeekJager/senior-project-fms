import { describe, expect, it } from 'vitest';
import { computeDue, defaultLead, programApplies, transitionEvent, type ProgramIntervals } from './service-program';

const none: ProgramIntervals = { intervalKm: null, leadKm: null, intervalDays: null, leadDays: null, intervalEngineHours: null, leadEngineHours: null };
const since = { at: new Date('2026-01-01T00:00:00Z'), km: 0, engineHours: null };
const at = (iso: string, odometerKm: number, engineHours: number | null = null) => ({ now: new Date(iso), odometerKm, engineHours });

describe('computeDue: whichever comes first', () => {
  it('a vehicle at 9,600 km on a 10,000 km program with a 500 km lead window is due', () => {
    const due = computeDue({ ...none, intervalKm: 10_000, leadKm: 500 }, since, at('2026-02-01T00:00:00Z', 9600));
    expect(due).toMatchObject({ nextDueKm: 10_000, status: 'due', dueBy: ['km'] });
    expect(computeDue({ ...none, intervalKm: 10_000, leadKm: 500 }, since, at('2026-02-01T00:00:00Z', 9499)).status).toBe('upcoming');
    expect(computeDue({ ...none, intervalKm: 10_000, leadKm: 500 }, since, at('2026-02-01T00:00:00Z', 10_000)).status).toBe('overdue');
  });

  it('the most urgent measure wins, and names itself', () => {
    const p = { ...none, intervalKm: 10_000, leadKm: 500, intervalDays: 180, leadDays: 14 };
    // 200 days on: overdue by time while far from the distance.
    const late = computeDue(p, since, at('2026-07-20T00:00:00Z', 3000));
    expect(late).toMatchObject({ status: 'overdue', dueBy: ['days'] });
    expect(late.nextDueAt?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
    // Both within their lead windows: due by both.
    expect(computeDue(p, since, at('2026-06-20T00:00:00Z', 9700))).toMatchObject({ status: 'due', dueBy: ['km', 'days'] });
  });

  it('counts engine hours from the last service, from 0 before the first reading, and skips them without readings', () => {
    const p = { ...none, intervalEngineHours: 250, leadEngineHours: 25 };
    expect(computeDue(p, since, at('2026-02-01T00:00:00Z', 0, 230))).toMatchObject({ nextDueEngineHours: 250, sinceEngineHours: 0, status: 'due', dueBy: ['engine_hours'] });
    expect(computeDue(p, { ...since, engineHours: 100 }, at('2026-02-01T00:00:00Z', 0, 230))).toMatchObject({ nextDueEngineHours: 350, status: 'upcoming' });
    // No engine-hour readings: not judged on hours, so nothing makes it due.
    expect(computeDue(p, since, at('2026-02-01T00:00:00Z', 50_000, null))).toMatchObject({ nextDueEngineHours: null, status: 'upcoming', dueBy: [] });
  });

  it('counts from where it starts: the last service', () => {
    const p = { ...none, intervalKm: 10_000, leadKm: 500 };
    expect(computeDue(p, { ...since, km: 42_000 }, at('2026-02-01T00:00:00Z', 51_600))).toMatchObject({ nextDueKm: 52_000, status: 'due' });
  });
});

describe('transitionEvent: once per move', () => {
  it('into due or overdue from anything less urgent, never back or sideways', () => {
    expect(transitionEvent(null, 'upcoming')).toBeNull();
    expect(transitionEvent(null, 'due')).toBe('ServiceDue');
    expect(transitionEvent(null, 'overdue')).toBe('ServiceOverdue');
    expect(transitionEvent('upcoming', 'due')).toBe('ServiceDue');
    expect(transitionEvent('due', 'overdue')).toBe('ServiceOverdue');
    expect(transitionEvent('due', 'due')).toBeNull();
    expect(transitionEvent('overdue', 'overdue')).toBeNull();
    expect(transitionEvent('overdue', 'due')).toBeNull();
    expect(transitionEvent('overdue', 'upcoming')).toBeNull();
  });
});

describe('programApplies', () => {
  const vehicle = { depotId: '1', vehicleType: 'truck', fuelType: 'diesel', make: 'Isuzu', model: 'NPR' };
  const any = { depotId: null, vehicleType: null, fuelType: null, make: null, model: null };
  it('matches on what it names, make and model without regard to case or spaces', () => {
    expect(programApplies(any, vehicle)).toBe(true);
    expect(programApplies({ ...any, depotId: '1', vehicleType: 'truck', make: ' isuzu', model: 'npr ' }, vehicle)).toBe(true);
    expect(programApplies({ ...any, depotId: '2' }, vehicle)).toBe(false);
    expect(programApplies({ ...any, fuelType: 'petrol' }, vehicle)).toBe(false);
    expect(programApplies({ ...any, make: 'Toyota' }, vehicle)).toBe(false);
  });
});

describe('defaultLead', () => {
  it('is a tenth of the interval, always below it', () => {
    expect(defaultLead(10_000)).toBe(1000);
    expect(defaultLead(180)).toBe(18);
    expect(defaultLead(1)).toBe(0);
  });
});
