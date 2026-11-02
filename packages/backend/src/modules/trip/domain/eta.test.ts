import { describe, expect, test } from 'vitest';
import { ARRIVAL_RADIUS_M, etaFrom, etaRequest, metresBetween, waypointsFor, type EtaStop } from './eta';

// FMS-86: a road due north from Bole, a stop every kilometre (0.009° of latitude is about 1 km).
const at = (km: number) => ({ latitude: 8.98 + km * 0.008993, longitude: 38.7578 });
const stop = (id: string, sequenceNumber: number, km: number | null, actualArrival: Date | null = null): EtaStop => ({
  id,
  sequenceNumber,
  coordinates: km === null ? null : at(km),
  actualArrival,
});
const STOPS = [stop('a', 1, 1), stop('b', 2, 2)];
const DESTINATION = at(3);
const T0 = new Date('2026-11-02T08:00:00Z');

describe('trip arrival estimate (FMS-86)', () => {
  test('the fixture: a kilometre between stops, and the arrival radius is well inside it', () => {
    expect(metresBetween(at(0), at(1))).toBeCloseTo(1000, -1);
    expect(ARRIVAL_RADIUS_M).toBeLessThan(500);
  });

  test('from the start: every stop ahead, then the destination, routed in travel order', () => {
    const request = etaRequest(at(0), STOPS, DESTINATION);
    expect(request).toMatchObject({ reached: [], ahead: [{ id: 'a' }, { id: 'b' }], atDestination: false });
    expect(waypointsFor(at(0), request)).toEqual([at(0), at(1), at(2), DESTINATION]);
  });

  test('each stop gets the time of the legs before it; the trip the sum, counted from the position', () => {
    const request = etaRequest(at(0), STOPS, DESTINATION);
    const legs = [
      { distanceKm: 1.1, durationSeconds: 90 },
      { distanceKm: 1.2, durationSeconds: 120.4 },
      { distanceKm: 1.05, durationSeconds: 60 },
    ];
    expect(etaFrom(request, legs, T0)).toEqual({
      stops: [
        { id: 'a', eta: new Date('2026-11-02T08:01:30Z') },
        { id: 'b', eta: new Date('2026-11-02T08:03:30Z') },
      ],
      arrivalAt: new Date('2026-11-02T08:04:30Z'),
      remainingKm: 3.35,
      remainingSeconds: 270,
    });
  });

  test('within the radius of a stop: it is reached, and only the stops after it are ahead', () => {
    const near = { latitude: at(1).latitude + 0.0009, longitude: at(1).longitude }; // about 100 m past it
    const request = etaRequest(near, STOPS, DESTINATION);
    expect(request.reached).toEqual(['a']);
    expect(request.ahead.map((s) => s.id)).toEqual(['b']);
  });

  test('a stop passed without coming near it is behind once a later one is reached: never routed back to', () => {
    // Stop a was missed (no arrival); b was reached earlier on.
    const stops = [stop('a', 1, 1), stop('b', 2, 2, new Date('2026-11-02T08:05:00Z')), stop('c', 3, 2.5)];
    const request = etaRequest(at(2.2), stops, DESTINATION);
    expect(request.reached).toEqual([]);
    expect(request.ahead.map((s) => s.id)).toEqual(['c']);
  });

  test('a stop already reached is not reached again; stops without coordinates get no time and are not routed to', () => {
    const stops = [stop('a', 1, 1, new Date('2026-11-02T08:02:00Z')), stop('x', 2, null), stop('b', 3, 2)];
    const request = etaRequest(at(1), stops, DESTINATION);
    expect(request.reached).toEqual([]);
    expect(request.ahead.map((s) => s.id)).toEqual(['b']);
  });

  test('at the destination: arrived at the position time, nothing left, nothing to route', () => {
    const request = etaRequest(DESTINATION, STOPS, DESTINATION);
    expect(request.atDestination).toBe(true);
    expect(waypointsFor(DESTINATION, request)).toEqual([DESTINATION]);
    expect(etaFrom(request, [], T0)).toEqual({ stops: [], arrivalAt: T0, remainingKm: 0, remainingSeconds: 0 });
  });

  test('no destination coordinates: the stops still get times, the trip no arrival', () => {
    const request = etaRequest(at(0), STOPS, null);
    expect(waypointsFor(at(0), request)).toEqual([at(0), at(1), at(2)]);
    const result = etaFrom(request, [{ distanceKm: 1, durationSeconds: 60 }, { distanceKm: 1, durationSeconds: 60 }], T0);
    expect(result.arrivalAt).toBeNull();
    expect(result.stops.map((s) => s.eta)).toEqual([new Date('2026-11-02T08:01:00Z'), new Date('2026-11-02T08:02:00Z')]);
  });
});
