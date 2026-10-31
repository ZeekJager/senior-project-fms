import { describe, expect, it } from 'vitest';
import { addisDayOf, forCaller, healthBand, summarise, type OverviewInput } from './overview';

const BANDS = { atRiskBelow: 75, healthyFrom: 85, staleAfterHours: 25 };
const NOW = new Date('2026-10-30T21:30:00Z'); // 00:30 on 31 October in Addis Ababa

const input = (extra: Partial<OverviewInput> = {}): OverviewInput => ({
  depotId: null,
  now: NOW,
  bands: BANDS,
  vehicles: [],
  drivers: [],
  trips: { today: [], underWay: [] },
  alerts: { items: [], counts: [] },
  incidents: { items: [], counts: [] },
  ...extra,
});

describe('healthBand', () => {
  it('bands a fresh score, and calls an old one stale and a missing one unscored', () => {
    const fresh = new Date(NOW.getTime() - 3_600_000);
    expect(healthBand(74, fresh, NOW, BANDS)).toBe('at_risk');
    expect(healthBand(75, fresh, NOW, BANDS)).toBe('watch');
    expect(healthBand(85, fresh, NOW, BANDS)).toBe('healthy');
    expect(healthBand(40, new Date(NOW.getTime() - 26 * 3_600_000), NOW, BANDS)).toBe('stale');
    expect(healthBand(40, null, NOW, BANDS)).toBe('stale');
    expect(healthBand(null, fresh, NOW, BANDS)).toBe('unscored');
  });
});

describe('addisDayOf', () => {
  it('is the Addis Ababa day, which starts at 21:00 UTC the evening before', () => {
    expect(addisDayOf(NOW)).toEqual({ day: '2026-10-31', from: new Date('2026-10-30T21:00:00Z'), to: new Date('2026-10-31T21:00:00Z') });
  });
});

describe('summarise', () => {
  it('counts a vehicle on a trip as neither available nor idle, and a flagged one as not available', () => {
    const v = (id: string, extra: Partial<OverviewInput['vehicles'][number]> = {}) => ({
      id,
      publicId: `v-${id}`,
      registrationNumber: `AA ${id}`,
      status: 'active',
      maintenanceFlag: false,
      healthScore: null,
      healthScoreUpdatedAt: null,
      ...extra,
    });
    const out = summarise(
      input({
        vehicles: [v('1'), v('2'), v('3', { maintenanceFlag: true }), v('4', { status: 'maintenance' }), v('5', { status: 'inactive' })],
        trips: { today: [{ status: 'en_route', n: 1 }], underWay: [{ vehicleId: '1', driverId: null, overdue: true }] },
      }),
    );
    expect(out.vehicles).toMatchObject({ total: 5, on_trip: 1, available: 1, flagged: 1, in_maintenance: 1, inactive: 1 });
    expect(out.trips).toMatchObject({ under_way: 1, overdue: 1 });
  });

  it('counts a driver who is absent, on leave or sick as absent, and one with an expired licence as unavailable', () => {
    const d = (id: string, extra: Partial<OverviewInput['drivers'][number]> = {}) => ({ id, publicId: `d-${id}`, fullName: null, licenceExpired: false, attendance: null, ...extra });
    const out = summarise(
      input({
        drivers: [d('1'), d('2', { attendance: 'on_leave' }), d('3', { attendance: 'sick' }), d('4', { attendance: 'late' }), d('5', { licenceExpired: true })],
        trips: { today: [], underWay: [{ vehicleId: null, driverId: '1', overdue: false }] },
      }),
    );
    expect(out.drivers).toEqual({ total: 5, on_trip: 1, available: 1, absent: 2, licence_expired: 1 });
  });

  it('adds up alerts and incidents by severity and status', () => {
    const out = summarise(
      input({
        alerts: { items: [], counts: [{ status: 'open', severity: 'critical', n: 2 }, { status: 'acknowledged', severity: 'critical', n: 1 }, { status: 'open', severity: 'low', n: 4 }] },
        incidents: { items: [], counts: [{ status: 'open', severity: 'high', n: 1 }, { status: 'investigating', severity: 'high', n: 3 }] },
      }),
    );
    expect(out.alerts).toMatchObject({ active: 7, unacknowledged: 6, by_severity: { critical: 3, high: 0, medium: 0, low: 4 } });
    expect(out.incidents).toMatchObject({ active: 4, by_status: { open: 1, investigating: 3 }, by_severity: { high: 4 } });
  });
});

describe('forCaller', () => {
  it('leaves out, as null, each section the caller may not read', () => {
    const all = summarise(input());
    expect(forCaller(all, ['command:read', 'alert:read'])).toMatchObject({ drivers: null, trips: null, incidents: null, alerts: { active: 0 } });
    expect(forCaller(all, ['command:read', 'driver:read', 'trip:read', 'alert:read', 'incident:read']).incidents).not.toBeNull();
  });
});
