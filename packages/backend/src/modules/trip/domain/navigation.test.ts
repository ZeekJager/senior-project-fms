import { describe, expect, test } from 'vitest';
import { bearingDegrees, compass, instruction, remainingWaypoints, type TripStopPlace } from './navigation';

// FMS-166: what is left to reach, which way it is, and each turn in plain words.

const stop = (n: number, status: TripStopPlace['status'], at: [number, number] | null = [9 + n / 100, 38.8]): TripStopPlace => ({
  id: `s${n}`,
  sequence_number: n,
  name: `Stop ${n}`,
  latitude: at?.[0] ?? null,
  longitude: at?.[1] ?? null,
  status,
});

describe('remainingWaypoints', () => {
  test('stops not completed or skipped, in order, then the destination', () => {
    const left = remainingWaypoints([stop(3, 'planned'), stop(1, 'completed'), stop(2, 'arrived'), stop(4, 'skipped')], { latitude: 8.54, longitude: 39.27, name: 'Adama' });
    expect(left.map((w) => [w.kind, w.name])).toEqual([
      ['stop', 'Stop 2'],
      ['stop', 'Stop 3'],
      ['destination', 'Adama'],
    ]);
    expect(left.at(-1)).toMatchObject({ stop_id: null, sequence_number: null, lat: 8.54, lng: 39.27 });
  });

  test('a stop with no coordinates cannot be driven to; no destination means stops only', () => {
    expect(remainingWaypoints([stop(1, 'planned', null), stop(2, 'planned')], null).map((w) => w.stop_id)).toEqual(['s2']);
    expect(remainingWaypoints([], null)).toEqual([]);
  });
});

describe('bearing and compass', () => {
  const addis = { latitude: 9.03, longitude: 38.74 };
  test('due north, east, south, west', () => {
    expect(bearingDegrees(addis, { latitude: 10, longitude: 38.74 })).toBe(0);
    expect(bearingDegrees(addis, { latitude: 9.03, longitude: 39.5 })).toBe(90);
    expect(bearingDegrees(addis, { latitude: 8, longitude: 38.74 })).toBe(180);
    expect(bearingDegrees(addis, { latitude: 9.03, longitude: 38 })).toBe(270);
  });
  test('Adama from Addis Ababa is south-east', () => {
    expect(compass(bearingDegrees(addis, { latitude: 8.54, longitude: 39.27 }))).toBe('south-east');
    expect(compass(359)).toBe('north');
    expect(compass(22)).toBe('north');
    expect(compass(23)).toBe('north-east');
  });
});

describe('instruction', () => {
  const step = (type: string, modifier: string | null = null, road = '', exit: number | null = null) => ({ type, modifier, road, exit });
  test.each([
    [step('depart', 'right'), 'Head off'],
    [step('depart', 'right', 'Bole Road'), 'Head off on Bole Road'],
    [step('turn', 'left', 'Ring Road'), 'Turn left onto Ring Road'],
    [step('turn', 'sharp right'), 'Turn sharp right'],
    [step('turn', 'uturn'), 'Make a U-turn'],
    [step('end of road', 'right', 'Jomo Kenyatta Avenue'), 'Turn right onto Jomo Kenyatta Avenue'],
    [step('new name', 'straight', 'Haile Gebresellasie Avenue'), 'Continue on Haile Gebresellasie Avenue'],
    [step('continue', 'slight right', 'Equatorial Guinea Street'), 'Keep slight right onto Equatorial Guinea Street'],
    [step('fork', 'slight left', 'Gabon Avenue'), 'Keep slight left at the fork onto Gabon Avenue'],
    [step('roundabout', 'right', 'Kenenisa Street', 3), 'At the roundabout, take the 3rd exit onto Kenenisa Street'],
    [step('rotary', 'right', '', 1), 'At the roundabout, take the 1st exit'],
    [step('exit roundabout', 'right', 'Kenenisa Street', 3), 'Leave the roundabout onto Kenenisa Street'],
    [step('merge', 'left', 'Expressway'), 'Merge left onto Expressway'],
    [step('off ramp', 'right', 'Adama'), 'Take the exit on the right onto Adama'],
    [step('notification', null, 'Road'), 'Continue on Road'],
  ])('%o → %s', (s, text) => expect(instruction(s)).toBe(text));

  test('arrive names the waypoint reached', () => {
    expect(instruction(step('arrive', 'right'), 'Adama depot')).toBe('Arrive at Adama depot');
    expect(instruction(step('arrive'))).toBe('Arrive at your destination');
  });
});
