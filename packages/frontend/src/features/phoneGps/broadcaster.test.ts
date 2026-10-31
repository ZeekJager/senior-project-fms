import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/errors'
import { KEEP_EVERY_MS, MAX_BATCH, PhoneGpsBroadcaster, distanceM, toPing, type GpsStatus } from './broadcaster'
import type { BufferedPing, PhonePing } from './buffer'

const T0 = Date.parse('2026-10-31T06:00:00Z')

/** A phone's GPS: the test feeds readings and errors to whoever watches. */
function fakeGps() {
  let watching: { ok: PositionCallback; fail: PositionErrorCallback } | null = null
  const clearWatch = vi.fn(() => (watching = null))
  const geolocation = {
    watchPosition: vi.fn((ok: PositionCallback, fail: PositionErrorCallback) => {
      watching = { ok, fail }
      return 7
    }),
    clearWatch,
    getCurrentPosition: vi.fn(),
  } as unknown as Geolocation
  return {
    geolocation,
    clearWatch,
    get watching() {
      return watching !== null
    },
    reading(at: number, coords: Partial<GeolocationCoordinates> = {}) {
      watching?.ok({
        timestamp: at,
        coords: { latitude: 9.01, longitude: 38.76, accuracy: 8, altitude: 2355, altitudeAccuracy: null, heading: 90, speed: 12, ...coords },
      } as GeolocationPosition)
    },
    error(code: 1 | 2 | 3) {
      watching?.fail({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: '' } as GeolocationPositionError)
    },
  }
}

/** The broadcaster with an in-memory buffer; `answer` decides how the server takes each batch. */
function setUp(answer: (pings: PhonePing[]) => Promise<unknown> = async () => ({})) {
  const gps = fakeGps()
  const stored: BufferedPing[] = []
  let seq = 0
  const sent: PhonePing[][] = []
  let online = true
  const statuses: GpsStatus[] = []
  const b = new PhoneGpsBroadcaster({
    geolocation: gps.geolocation,
    buffer: {
      add: async (ping) => void stored.push({ seq: ++seq, ownerId: 'u-1', ping }),
      oldest: async (limit) => stored.slice(0, limit),
      count: async () => stored.length,
      remove: async (seqs) => {
        for (const s of seqs) stored.splice(stored.findIndex((p) => p.seq === s), 1)
      },
    },
    send: (pings) => {
      sent.push(pings)
      return answer(pings)
    },
    online: () => online,
    maxAccuracyM: 100,
  })
  b.subscribe((s) => statuses.push(s))
  return { b, gps, stored, sent, statuses, setOnline: (v: boolean) => (online = v) }
}

/** Lets the broadcaster's promises (buffer, send) settle. */
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => vi.useRealTimers())

describe('the phone as the vehicle GPS (FMS-57)', () => {
  it('drops readings less precise than the limit, and keeps one reading every 10 s', async () => {
    const { b, gps, stored, statuses, setOnline } = setUp()
    // Offline, so what is kept stays on the phone to be looked at.
    setOnline(false)
    b.track(true)
    gps.reading(T0, { accuracy: 250 })
    await settle()
    expect(stored).toEqual([])
    expect(statuses.at(-1)).toMatchObject({ state: 'weak', dropped: 1 })

    gps.reading(T0 + 1_000, { accuracy: 100 })
    gps.reading(T0 + 4_000)
    gps.reading(T0 + 1_000 + KEEP_EVERY_MS)
    await settle()
    expect(stored.map((s) => s.ping.recorded_at)).toEqual([new Date(T0 + 1_000).toISOString(), new Date(T0 + 11_000).toISOString()])
    expect(statuses.at(-1)).toMatchObject({ state: 'on', dropped: 1 })
  })

  it('sends at most 6 batches a minute, the first position at once, whatever the phone reports', async () => {
    const { b, gps, sent } = setUp()
    b.start()
    b.track(true)
    for (let ms = 0; ms < 60_000; ms += 1_000) {
      gps.reading(Date.now())
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(sent).toHaveLength(6)
    expect(sent[0]).toHaveLength(1)
    expect(sent.flat()).toHaveLength(6)
    b.stop()
  })

  it('ending the trip stops the watch; what is still on the phone is sent afterwards', async () => {
    const { b, gps, sent, stored, setOnline, statuses } = setUp()
    b.start()
    b.track(true)
    setOnline(false)
    gps.reading(T0)
    gps.reading(T0 + 10_000)
    await settle()
    b.track(false)
    expect(gps.clearWatch).toHaveBeenCalledWith(7)
    expect(gps.watching).toBe(false)
    expect(statuses.at(-1)?.state).toBe('off')

    setOnline(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toEqual([[expect.objectContaining({ recorded_at: new Date(T0).toISOString() }), expect.objectContaining({ recorded_at: new Date(T0 + 10_000).toISOString() })]])
    expect(stored).toEqual([])
    b.stop()
  })

  it('no signal, a server error or a session to renew keep the batch; a refusal for good drops it', async () => {
    let answer: () => Promise<unknown> = () => Promise.reject(new TypeError('Failed to fetch'))
    const { b, gps, stored, sent } = setUp(() => answer())
    b.track(true)
    gps.reading(T0)
    await settle()
    expect(sent).toHaveLength(1)
    expect(stored).toHaveLength(1)

    for (const [status, code] of [
      [503, 'SERVICE_UNAVAILABLE'],
      [401, 'AUTH_TOKEN_EXPIRED'],
      [429, 'RATE_LIMITED'],
    ] as const) {
      answer = () => Promise.reject(new ApiError(status, code, code))
      await vi.advanceTimersByTimeAsync(10_000)
      await b.flush()
      expect(stored).toHaveLength(1)
    }

    answer = () => Promise.reject(new ApiError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'no_trip_under_way'))
    await vi.advanceTimersByTimeAsync(10_000)
    await b.flush()
    expect(stored).toEqual([])
    expect(sent).toHaveLength(5)
  })

  it('sends the oldest 500 first when much is waiting', async () => {
    const { b, gps, stored, sent, setOnline } = setUp()
    setOnline(false)
    b.track(true)
    for (let i = 0; i < 620; i++) gps.reading(T0 + i * KEEP_EVERY_MS)
    await settle()
    setOnline(true)
    await b.flush()
    expect(sent[0]).toHaveLength(MAX_BATCH)
    expect(sent[0][0].recorded_at).toBe(new Date(T0).toISOString())
    expect(stored).toHaveLength(120)
  })

  it('blocked location says so, and Try again asks once more', async () => {
    const { b, gps, statuses } = setUp()
    b.track(true)
    gps.error(1)
    expect(statuses.at(-1)?.state).toBe('denied')
    expect(gps.watching).toBe(false)
    gps.error(3)
    b.retry()
    expect(gps.geolocation.watchPosition).toHaveBeenCalledTimes(2)
    expect(statuses.at(-1)?.state).toBe('starting')
  })

  it('a phone without location is unavailable', () => {
    const statuses: GpsStatus[] = []
    const b = new PhoneGpsBroadcaster({ geolocation: undefined, buffer: {} as never, send: async () => ({}), online: () => true })
    b.subscribe((s) => statuses.push(s))
    b.track(true)
    expect(statuses.at(-1)?.state).toBe('unavailable')
  })
})

describe('a reading as a ping', () => {
  const position = (coords: Partial<GeolocationCoordinates>, at = T0) =>
    ({ timestamp: at, coords: { latitude: 9.01, longitude: 38.76, accuracy: 8.26, altitude: null, altitudeAccuracy: null, heading: null, speed: null, ...coords } }) as GeolocationPosition

  it("takes the phone's speed in km/h, or works it out from the last position when the phone gives none", () => {
    expect(toPing(position({ speed: 12.5, heading: 90.04 }), null)).toEqual({
      recorded_at: '2026-10-31T06:00:00.000Z',
      lat: 9.01,
      lng: 38.76,
      speed_kmh: 45,
      heading: 90,
      accuracy_m: 8.3,
      altitude_m: null,
    })
    const first = toPing(position({}), null)
    expect(first.speed_kmh).toBe(0)
    // 0.009 degrees of latitude in 10 s: about 1 km, so about 360 km/h, capped at the API's 300.
    const next = toPing(position({ latitude: 9.019 }, T0 + 10_000), first)
    expect(next.speed_kmh).toBe(300)
    const slower = toPing(position({ latitude: 9.0109 }, T0 + 10_000), first)
    expect(slower.speed_kmh).toBeCloseTo((distanceM(first, { lat: 9.0109, lng: 38.76 }) / 10) * 3.6, 0)
  })

  it('leaves out a heading or altitude the API would refuse', () => {
    expect(toPing(position({ heading: Number.NaN, altitude: 20_000 }), null)).toMatchObject({ heading: null, altitude_m: null })
  })
})
