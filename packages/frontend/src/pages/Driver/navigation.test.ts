import { describe, expect, it } from 'vitest'
import { compass, distanceText, durationText, googleMapsUrl, lineLength, metres, nearestOnLine, progress, type LngLat, type TripNavigation } from './navigation'

// FMS-166: where the driver is on the road, between two answers from the server.

/** A road due east along 9° N: 0.01° of longitude is about 1.1 km. */
const LINE: LngLat[] = [
  [38.7, 9],
  [38.71, 9],
  [38.72, 9],
  [38.73, 9],
]
const step = (type: string, lng: number, instruction: string) => ({ instruction, type, modifier: null, road: null, distance_m: 0, duration_s: 0, lat: 9, lng })
const road: NonNullable<TripNavigation['road']> = {
  distance_km: 3.3,
  duration_seconds: 300,
  arrival_at: '2026-11-28T10:00:00Z',
  geometry: { type: 'LineString', coordinates: LINE },
  steps: [step('depart', 38.7, 'Head off'), step('turn', 38.71, 'Turn left'), step('turn', 38.72, 'Turn right'), step('arrive', 38.73, 'Arrive at Adama')],
}

describe('the driver on the road', () => {
  it('measures the line and finds the closest point on it', () => {
    expect(lineLength(LINE)).toBeCloseTo(3 * metres({ lat: 9, lng: 38.7 }, { lat: 9, lng: 38.71 }), 0)
    const near = nearestOnLine(LINE, { lat: 9.001, lng: 38.715 })
    expect(near.index).toBe(1)
    expect(near.t).toBeCloseTo(0.5, 2)
    expect(near.offM).toBeGreaterThan(100)
    expect(near.offM).toBeLessThan(120)
  })

  it('the next turn is the first ahead; one just passed is done', () => {
    const atStart = progress(road, { lat: 9, lng: 38.7 })
    expect(atStart.next?.instruction).toBe('Turn left')
    expect(atStart.toNextM).toBeCloseTo(1099, -1)
    expect(atStart.offRoute).toBe(false)

    const justPast = progress(road, { lat: 9, lng: 38.71005 })
    expect(justPast.next?.instruction).toBe('Turn right')
    const nearEnd = progress(road, { lat: 9, lng: 38.7295 })
    expect(nearEnd.next?.instruction).toBe('Arrive at Adama')
    expect(nearEnd.leftM).toBeLessThan(60)
    expect(progress(road, { lat: 9, lng: 38.73 }).next).toBeNull()
  })

  it('more than 150 m from the road is off the road', () => {
    expect(progress(road, { lat: 9.0012, lng: 38.715 }).offRoute).toBe(false)
    expect(progress(road, { lat: 9.002, lng: 38.715 }).offRoute).toBe(true)
  })
})

describe('words and links', () => {
  it('distances and durations as a driver reads them', () => {
    expect([distanceText(4), distanceText(348), distanceText(1234), distanceText(24_400)]).toEqual(['10 m', '350 m', '1.2 km', '24 km'])
    expect([durationText(20), durationText(45 * 60), durationText(130 * 60), durationText(120 * 60)]).toEqual(['1 min', '45 min', '2 h 10 min', '2 h'])
    expect([compass(0), compass(135), compass(350)]).toEqual(['north', 'south-east', 'north'])
  })

  it('Google Maps through the stops left to the destination; nothing with no waypoint', () => {
    const url = googleMapsUrl([
      { kind: 'stop', stop_id: 's2', sequence_number: 2, name: 'Bishoftu', lat: 8.75, lng: 38.98 },
      { kind: 'destination', stop_id: null, sequence_number: null, name: 'Adama', lat: 8.54, lng: 39.27 },
    ])!
    const q = new URL(url).searchParams
    expect(url.startsWith('https://www.google.com/maps/dir/?')).toBe(true)
    expect([q.get('destination'), q.get('waypoints'), q.get('travelmode')]).toEqual(['8.54,39.27', '8.75,38.98', 'driving'])
    expect(googleMapsUrl([])).toBeNull()
  })
})
