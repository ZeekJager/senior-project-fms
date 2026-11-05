import { describe, expect, test } from 'vitest';
import { boundingBox, normalizePolygon, type LineString } from './geometry';
import {
  DEFAULT_LOCATION_THRESHOLDS,
  evaluateLocation,
  fenceKey,
  INITIAL_LOCATION_STATE,
  ROAD_KEY,
  type FenceRule,
  type LocationState,
} from './location-rules';
import type { RulePing } from './telemetry-rules';

// FMS-90: leaving or entering a geofence, and straying from the trip's road.

const SEC = 1000;
const IN = { lat: 9.0108, lng: 38.7613 };
const OUT = { lat: 9.0108, lng: 38.7700 };
const yardPolygon = normalizePolygon({
  type: 'Polygon',
  coordinates: [[[38.7603, 9.0098], [38.7623, 9.0098], [38.7623, 9.0118], [38.7603, 9.0118]]],
});
const fence = (over: Partial<FenceRule> = {}): FenceRule => ({ id: '7', version: 1, kind: 'keep_in', applies: 'always', polygon: yardPolygon, box: boundingBox(yardPolygon), ...over });

/** Pings 10 s apart from t = 0 at the given positions. */
const pings = (positions: { lat: number; lng: number }[], tripId: string | null = null, start = 0): RulePing[] =>
  positions.map((p, i) => ({ at: start + i * 10 * SEC, speedKmh: 30, ignitionOn: true, lat: p.lat, lng: p.lng, tripId }));

function run(list: RulePing[], fences: FenceRule[] = [fence()], opts: { open?: string[]; state?: LocationState; roads?: Map<string, LineString> } = {}) {
  const open = new Set(opts.open ?? []);
  const out = evaluateLocation(opts.state ?? INITIAL_LOCATION_STATE, open, list, fences, opts.roads ?? new Map(), DEFAULT_LOCATION_THRESHOLDS);
  return { ...out, open };
}

describe('a keep-in geofence (the yard)', () => {
  test('leaving it raises one flag, however long the vehicle stays out', () => {
    const { actions, open } = run(pings([IN, IN, OUT, OUT, OUT, OUT]));
    expect(actions).toEqual([expect.objectContaining({ kind: 'raise', flagType: 'geofence_violation', geofenceId: '7', observedAt: 20 * SEC, details: { kind: 'keep_in' } })]);
    expect(open).toEqual(new Set([fenceKey('7')]));
  });

  test('3 pings back inside resolve it, from the first of them', () => {
    const { actions } = run(pings([IN, OUT, IN, IN, IN]));
    expect(actions.map((a) => a.kind)).toEqual(['raise', 'resolve']);
    expect(actions[1]).toMatchObject({ reason: 'cleared', resolvedAt: 20 * SEC });
  });

  test('a fix jumping back and forth across the fence line keeps one flag', () => {
    const { actions } = run(pings([IN, OUT, IN, OUT, IN, OUT, IN]));
    expect(actions.filter((a) => a.kind === 'raise')).toHaveLength(1);
  });

  test('a vehicle first seen outside is not flagged until it has been in and left again', () => {
    expect(run(pings([OUT, OUT, OUT])).actions).toEqual([]);
    expect(run(pings([OUT, IN, OUT])).actions).toHaveLength(1);
  });

  test('going dark inside and reappearing outside is leaving: the side is kept across the gap', () => {
    const before = run(pings([IN, IN])).state;
    const later = pings([OUT], null, 60 * 60 * SEC);
    expect(run(later, [fence()], { state: before }).actions).toEqual([expect.objectContaining({ kind: 'raise' })]);
  });

  test('an edited fence starts again: its old side is forgotten', () => {
    const before = run(pings([IN, IN])).state;
    expect(run(pings([OUT], null, 30 * SEC), [fence({ version: 2 })], { state: before }).actions).toEqual([]);
  });

  test('"off trips only": a vehicle on a trip may leave; ending the trip outside is no violation, starting one ends it', () => {
    const offTrip = [fence({ applies: 'off_trip' })];
    expect(run(pings([IN, OUT, OUT], 'trip-1'), offTrip).actions).toEqual([]);
    const left = run(pings([IN, OUT]), offTrip);
    expect(left.actions).toHaveLength(1);
    const started = run(pings([OUT], 'trip-1', 30 * SEC), offTrip, { state: left.state, open: [...left.open] });
    expect(started.actions).toEqual([expect.objectContaining({ kind: 'resolve', reason: 'trip_started' })]);
  });
});

describe('a keep-out geofence (a no-go zone)', () => {
  test('entering it raises a flag; leaving it for 3 pings resolves it', () => {
    const { actions } = run(pings([OUT, IN, IN, OUT, OUT, OUT]), [fence({ kind: 'keep_out' })]);
    expect(actions.map((a) => [a.kind, a.flagType])).toEqual([
      ['raise', 'geofence_violation'],
      ['resolve', 'geofence_violation'],
    ]);
    expect(actions[0]).toMatchObject({ observedAt: 10 * SEC, details: { kind: 'keep_out' } });
  });

  test('each fence has its own flag', () => {
    const zones = [fence({ id: '1', kind: 'keep_out' }), fence({ id: '2', kind: 'keep_out' })];
    const { open } = run(pings([OUT, IN]), zones);
    expect(open).toEqual(new Set([fenceKey('1'), fenceKey('2')]));
  });
});

describe('route deviation', () => {
  // The trip's road runs east along latitude 9.0108; 500 m is about 0.0045 degrees of latitude.
  const road: LineString = { type: 'LineString', coordinates: [[38.70, 9.0108], [38.80, 9.0108]] };
  const roads = new Map([['trip-1', road]]);
  const onRoad = { lat: 9.0108, lng: 38.75 };
  const off = (m: number) => ({ lat: 9.0108 + m / 111_195, lng: 38.75 });

  test('600 m off the road for 3 pings raises one flag, from the first of them', () => {
    const { actions, open } = run(pings([onRoad, off(600), off(600), off(600), off(700)], 'trip-1'), [], { roads });
    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'raise',
        flagType: 'route_deviation',
        geofenceId: null,
        observedAt: 10 * SEC,
        details: { distance_m: 600, route_deviation_m: 500, consecutive_pings: 3 },
      }),
    ]);
    expect(open).toEqual(new Set([ROAD_KEY]));
  });

  test('2 pings off the road, or 3 at 450 m, raise none', () => {
    expect(run(pings([off(600), off(600), onRoad, off(600)], 'trip-1'), [], { roads }).actions).toEqual([]);
    expect(run(pings([off(450), off(450), off(450)], 'trip-1'), [], { roads }).actions).toEqual([]);
  });

  test('3 pings back on the road resolve it, with the furthest it strayed', () => {
    const { actions } = run(pings([off(600), off(900), off(600), onRoad, onRoad, onRoad], 'trip-1'), [], { roads });
    expect(actions[1]).toMatchObject({ kind: 'resolve', reason: 'cleared', resolvedAt: 30 * SEC, details: { max_distance_m: 900 } });
  });

  test('pings further apart than 2 minutes are not consecutive', () => {
    const list = [...pings([off(600), off(600)], 'trip-1'), ...pings([off(600)], 'trip-1', 10 * 60 * SEC)];
    expect(run(list, [], { roads }).actions).toEqual([]);
  });

  test('the trip ending (a ping on no trip) resolves it', () => {
    const strayed = run(pings([off(600), off(600), off(600)], 'trip-1'), [], { roads });
    const after = run(pings([off(600)], null, 40 * SEC), [], { roads, state: strayed.state, open: [...strayed.open] });
    expect(after.actions).toEqual([expect.objectContaining({ kind: 'resolve', reason: 'trip_ended' })]);
  });

  test('a trip whose route has no road is not judged', () => {
    expect(run(pings([off(2000), off(2000), off(2000)], 'trip-2'), [], { roads }).actions).toEqual([]);
  });

  test('the threshold is the depot’s: 1 km for 2 pings', () => {
    const open = new Set<string>();
    const t = { ...DEFAULT_LOCATION_THRESHOLDS, routeDeviationM: 1000, routeDeviationPings: 2 };
    expect(evaluateLocation(INITIAL_LOCATION_STATE, open, pings([off(900), off(900)], 'trip-1'), [], roads, t).actions).toEqual([]);
    expect(evaluateLocation(INITIAL_LOCATION_STATE, open, pings([off(1100), off(1100)], 'trip-1'), [], roads, t).actions).toHaveLength(1);
  });
});
