import { describe, expect, test } from 'vitest';
import { DEFAULT_THRESHOLDS, evaluatePings, INITIAL_STATE, MAX_PING_GAP_MS, type RuleFlagType, type RulePing, type RuleState } from './telemetry-rules';

const T0 = Date.parse('2026-10-22T08:00:00Z');
const STEP = 10_000;

/** Pings 10 s apart from `from` (ms after T0), one per speed. */
function pings(speeds: readonly number[], from = 0, extra: Partial<RulePing> = {}): RulePing[] {
  return speeds.map((speedKmh, i) => ({ at: T0 + from + i * STEP, speedKmh, ignitionOn: true, lat: 9.01, lng: 38.76, tripId: null, ...extra }));
}

function run(list: readonly RulePing[], open: RuleFlagType[] = [], state: RuleState = INITIAL_STATE, t = DEFAULT_THRESHOLDS) {
  const openSet = new Set(open);
  const result = evaluatePings(state, openSet, list, t);
  return { ...result, open: openSet };
}

describe('speeding (over 80 km/h by default)', () => {
  test('3 pings at 90 km/h raise one flag, from the first of them', () => {
    const list = pings([60, 90, 90, 90]);
    const { actions, open } = run(list);
    expect(actions).toEqual([
      { kind: 'raise', flagType: 'speeding', observedAt: list[1].at, ping: list[3], details: { speed_limit_kmh: 80, speed_kmh: 90, consecutive_pings: 3 } },
    ]);
    expect(open).toEqual(new Set(['speeding']));
  });

  test('2 pings at 90 km/h raise none, nor 2 and 2 with one under the limit between', () => {
    expect(run(pings([90, 90])).actions).toEqual([]);
    expect(run(pings([90, 90, 80, 90, 90])).actions).toEqual([]);
  });

  test('exactly the limit is not speeding', () => {
    expect(run(pings([80, 80, 80, 80])).actions).toEqual([]);
  });

  test('more pings over the limit do not raise a second flag', () => {
    const { actions } = run(pings([90, 95, 100, 110, 120, 130]));
    expect(actions.filter((a) => a.kind === 'raise')).toHaveLength(1);
  });

  test('3 pings at or under the limit resolve it, at the first of them', () => {
    const list = pings([90, 90, 90, 70, 80, 60]);
    const { actions, open } = run(list);
    expect(actions.map((a) => a.kind)).toEqual(['raise', 'resolve']);
    expect(actions[1]).toEqual({ kind: 'resolve', flagType: 'speeding', resolvedAt: list[3].at, reason: 'cleared' });
    expect(open.size).toBe(0);
  });

  test('a ping over the limit among the clearing ones starts the count again', () => {
    const { actions } = run(pings([90, 90, 90, 70, 70, 90, 70, 70]));
    expect(actions.map((a) => a.kind)).toEqual(['raise']);
  });

  test('a flag already open (in the database) is resolved, not raised again', () => {
    expect(run(pings([90, 90, 90]), ['speeding']).actions).toEqual([]);
    expect(run(pings([50, 50, 50]), ['speeding']).actions.map((a) => a.kind)).toEqual(['resolve']);
  });

  test('a depot with its own limit uses it', () => {
    const t = { ...DEFAULT_THRESHOLDS, speedLimitKmh: 60, speedingPings: 2 };
    expect(run(pings([70, 70]), [], INITIAL_STATE, t).actions.map((a) => a.flagType)).toEqual(['speeding']);
  });

  test('counting carries over from one batch to the next through the state', () => {
    const first = run(pings([90, 90]));
    expect(first.actions).toEqual([]);
    const second = run(pings([90], 2 * STEP), [], first.state);
    expect(second.actions).toMatchObject([{ kind: 'raise', flagType: 'speeding', observedAt: T0 }]);
  });

  test('pings more than 2 minutes apart are not consecutive', () => {
    const list = [...pings([90, 90]), ...pings([90], STEP + MAX_PING_GAP_MS + 1000)];
    expect(run(list).actions).toEqual([]);
  });
});

describe('idling (5 minutes at 0 km/h by default)', () => {
  const stop = (minutes: number, from = 0, extra: Partial<RulePing> = {}) => pings(Array(minutes * 6 + 1).fill(0), from, extra);

  test('5 minutes stopped with the engine on raise one flag, from the first stopped ping', () => {
    const list = [...pings([30]), ...stop(5, STEP)];
    const { actions } = run(list);
    expect(actions).toEqual([{ kind: 'raise', flagType: 'idling', observedAt: list[1].at, ping: list.at(-1), details: { idle_minutes: 5 } }]);
  });

  test('4 minutes 50 seconds stopped raise none', () => {
    expect(run(stop(5).slice(0, -1)).actions).toEqual([]);
  });

  test('staying stopped raises no second flag; moving resolves it at that ping', () => {
    const list = [...stop(8), ...pings([20], 8 * 60_000 + STEP)];
    const { actions, open } = run(list);
    expect(actions.map((a) => `${a.kind}:${a.flagType}`)).toEqual(['raise:idling', 'resolve:idling']);
    expect(actions[1]).toEqual({ kind: 'resolve', flagType: 'idling', resolvedAt: list.at(-1)!.at, reason: 'moving' });
    expect(open.size).toBe(0);
  });

  test('the engine reported off is parked, not idling, and ends idling', () => {
    expect(run(stop(6, 0, { ignitionOn: false })).actions).toEqual([]);
    const list = [...stop(6), ...pings([0], 6 * 60_000 + STEP, { ignitionOn: false })];
    expect(run(list).actions.at(-1)).toMatchObject({ kind: 'resolve', flagType: 'idling', reason: 'engine_off' });
  });

  test('a device that does not report the engine counts as running', () => {
    expect(run(stop(5, 0, { ignitionOn: null })).actions.map((a) => a.flagType)).toEqual(['idling']);
  });

  test('a gap over 2 minutes ends idling at the last ping before it, and the stop counts again', () => {
    const list = [...stop(6), ...stop(1, 6 * 60_000 + MAX_PING_GAP_MS + 1000)];
    const { actions } = run(list);
    expect(actions.map((a) => `${a.kind}:${a.flagType}`)).toEqual(['raise:idling', 'resolve:idling']);
    expect(actions[1]).toMatchObject({ resolvedAt: T0 + 6 * 60_000, reason: 'signal_lost' });
  });

  test('a vehicle speeding then stopping gets both flags, each resolved on its own terms', () => {
    const list = [...pings([90, 90, 90]), ...stop(5, 3 * STEP)];
    expect(run(list).actions.map((a) => `${a.kind}:${a.flagType}`)).toEqual(['raise:speeding', 'resolve:speeding', 'raise:idling']);
  });
});
