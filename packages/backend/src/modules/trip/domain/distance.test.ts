import { describe, expect, test } from 'vitest';
import { measureTrip, MAX_PLAUSIBLE_KMH, ODOMETER_EDGE_MS, odometerDistance, trackDistance, withoutGlitches, type TrackPoint } from './distance';
import { metresBetween } from './eta';

const MIN = 60_000;
const START = Date.parse('2026-11-10T06:00:00Z');

/** A point `minutes` after the start, `km` east of the depot along the equator-ish line at 9° N, moving. */
function at(minutes: number, km: number, extra: Partial<TrackPoint> = {}): TrackPoint {
  const metresPerDegree = metresBetween({ latitude: 9, longitude: 38.7 }, { latitude: 9, longitude: 38.701 }) * 1000;
  return { at: START + minutes * MIN, latitude: 9, longitude: 38.7 + (km * 1000) / metresPerDegree, speedKmh: 40, odometerKm: null, source: 'phone', ...extra };
}

/** A drive at 40 km/h, a point a minute, for `minutes`. */
const drive = (minutes: number, extra: (m: number) => Partial<TrackPoint> = () => ({})) =>
  Array.from({ length: minutes + 1 }, (_, m) => at(m, (40 * m) / 60, extra(m)));

describe('the GPS track', () => {
  test('sums the steps: an hour at 40 km/h is 40 km', () => {
    expect(trackDistance(drive(60))).toBeCloseTo(40, 1);
  });

  test('ignores drift while parked: steps with both ends standing still count nothing', () => {
    const parked = [0, 1, 2, 3].map((m) => at(m, m % 2 === 0 ? 0 : 0.03, { speedKmh: 0 }));
    expect(trackDistance(parked)).toBe(0);
  });

  test('drops a glitch: one position kilometres away between two close ones', () => {
    const track = drive(10);
    const glitched = [...track.slice(0, 5), { ...track[5], longitude: track[5].longitude + 0.5 }, ...track.slice(6)];
    expect(withoutGlitches(glitched)).toHaveLength(track.length - 1);
    expect(trackDistance(glitched)).toBeCloseTo(trackDistance(track), 1);
  });

  test('drops a glitch at either end, keeping the rest of the track', () => {
    const track = drive(10);
    const badFirst = [{ ...track[0], longitude: track[0].longitude - 0.5 }, ...track.slice(1)];
    const badLast = [...track.slice(0, -1), { ...track[10], longitude: track[10].longitude + 0.5 }];
    expect(trackDistance(badFirst)).toBeCloseTo(trackDistance(track.slice(1)), 3);
    expect(trackDistance(badLast)).toBeCloseTo(trackDistance(track.slice(0, -1)), 3);
  });

  test('a gap counts as the straight line across it', () => {
    const gapped = [at(0, 0), at(30, 20), at(31, 20.7)];
    expect(trackDistance(gapped)).toBeCloseTo(20.7, 1);
  });

  test(`a step faster than ${MAX_PLAUSIBLE_KMH} km/h counts nothing even when no neighbour shows it as a glitch`, () => {
    expect(trackDistance([at(0, 0), at(1, 10)])).toBe(0); // 600 km/h
  });
});

describe('the odometer', () => {
  const device = (m: number) => ({ source: 'device', odometerKm: 12_000 + (40 * m) / 60 });

  test("the vehicle's own readings bracketing the trip give the difference", () => {
    expect(odometerDistance(drive(60, device), START, START + 60 * MIN)).toBeCloseTo(40, 3);
  });

  test("a phone's or a user's odometer is not a reading", () => {
    expect(odometerDistance(drive(60, (m) => ({ source: 'phone', odometerKm: 12_000 + m })), START, START + 60 * MIN)).toBeNull();
    expect(odometerDistance(drive(60, (m) => ({ source: 'api', odometerKm: 12_000 + m })), START, START + 60 * MIN)).toBeNull();
  });

  test(`readings that start or stop more than ${ODOMETER_EDGE_MS / MIN} minutes from the trip's ends do not bracket it`, () => {
    const late = drive(60, (m) => (m >= 6 ? device(m) : {}));
    const early = drive(60, (m) => (m <= 54 ? device(m) : {}));
    expect(odometerDistance(late, START, START + 60 * MIN)).toBeNull();
    expect(odometerDistance(early, START, START + 60 * MIN)).toBeNull();
    expect(odometerDistance(drive(60, (m) => (m >= 5 && m <= 55 ? device(m) : {})), START, START + 60 * MIN)).toBeCloseTo((40 * 50) / 60, 3);
  });

  test('a meter that goes backwards, or implies an impossible speed, is not trusted', () => {
    const backwards = drive(60, (m) => ({ ...device(m), odometerKm: m === 30 ? 11_000 : device(m).odometerKm }));
    const swapped = drive(60, (m) => ({ ...device(m), odometerKm: m === 60 ? 15_000 : device(m).odometerKm }));
    expect(odometerDistance(backwards, START, START + 60 * MIN)).toBeNull();
    expect(odometerDistance(swapped, START, START + 60 * MIN)).toBeNull();
  });
});

describe('a trip', () => {
  test('is measured by the odometer when it brackets the trip, else by the track', () => {
    const end = START + 60 * MIN;
    expect(measureTrip(drive(60, (m) => ({ source: 'device', odometerKm: 500 + m })), START, end)).toMatchObject({ source: 'odometer', km: 60, points: 61 });
    expect(measureTrip(drive(60), START, end)).toMatchObject({ source: 'gps', points: 61 });
  });

  test('counts only positions between its start and its end, in time order', () => {
    const before = at(-30, -20);
    const after = at(90, 60);
    const shuffled = [...drive(60)].reverse();
    expect(measureTrip([before, ...shuffled, after], START, START + 60 * MIN)).toMatchObject({ source: 'gps', points: 61 });
    expect((measureTrip([before, ...shuffled, after], START, START + 60 * MIN) as { km: number }).km).toBeCloseTo(40, 1);
  });

  test('with fewer than two positions it has no distance, and says why', () => {
    expect(measureTrip([], START, START + 60 * MIN)).toEqual({ km: null, reason: 'no_positions', points: 0 });
    expect(measureTrip([at(10, 6)], START, START + 60 * MIN)).toEqual({ km: null, reason: 'no_positions', points: 1 });
  });
});
