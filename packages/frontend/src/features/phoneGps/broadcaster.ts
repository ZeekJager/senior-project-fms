import { outcomeOf } from '@/lib/offlineQueue'
import { ApiError } from '@/lib/api/errors'
import type { BufferedPing, PhonePing } from './buffer'

// The driver's phone as the vehicle's GPS while their trip is under way (FMS-57, docs/phone-gps.md): readings
// from watchPosition, the imprecise ones dropped, one kept every 10 s, buffered on the phone and sent in
// batches to POST /tracking/gps-pings, at most one request every 10 s.

/** Readings less precise than this (metres, the phone's own estimate) are dropped. Configuration: VITE_GPS_MAX_ACCURACY_M. */
export const MAX_ACCURACY_M = positive(import.meta.env.VITE_GPS_MAX_ACCURACY_M) ?? 100
/** One reading kept per this many ms: a tracker device's cadence, which the speeding rule's 3 pings assume (FMS-46). */
export const KEEP_EVERY_MS = 10_000
/** Requests are at least this far apart: at most 6 a minute. The first position of a trip goes at once. */
export const SEND_EVERY_MS = 10_000
/** How often the loop looks whether a batch may go. */
const TICK_MS = 1_000
/** Positions per request, the API's limit. */
export const MAX_BATCH = 500

function positive(text: string | undefined): number | undefined {
  const n = Number(text)
  return text && Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * - `off`: no trip under way, nothing watched.
 * - `starting`: asked for the position, none yet.
 * - `on`: positions are coming in.
 * - `weak`: readings come, but none precise enough to keep.
 * - `denied`: the driver (or the browser) refused location.
 * - `unavailable`: the phone cannot tell where it is, or has no location at all.
 */
export type GpsState = 'off' | 'starting' | 'on' | 'weak' | 'denied' | 'unavailable'

export interface GpsStatus {
  state: GpsState
  /** Positions on the phone not yet sent. */
  waiting: number
  /** When the server last took a batch. */
  lastSentAt: number | null
  /** Readings dropped as imprecise since tracking started. */
  dropped: number
}

export interface BroadcasterDeps {
  geolocation: Geolocation | undefined
  buffer: {
    add(ping: PhonePing): Promise<void>
    oldest(limit: number): Promise<BufferedPing[]>
    count(): Promise<number>
    remove(seqs: readonly number[]): Promise<void>
  }
  /** POST /tracking/gps-pings. */
  send(pings: PhonePing[]): Promise<unknown>
  online: () => boolean
  now?: () => number
  maxAccuracyM?: number
}

const EARTH_M = 6_371_000
const rad = (deg: number) => (deg * Math.PI) / 180

/** Metres between two points (haversine). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.sqrt(h))
}

const round1 = (n: number) => Math.round(n * 10) / 10
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/**
 * A reading as a ping. The speed is the phone's when it gives one, else worked out from the last kept position
 * (many phones report none); the API takes 0 to 300 km/h, a heading 0 to 360 and an altitude -1,000 to 10,000 m.
 */
export function toPing(position: GeolocationPosition, previous: PhonePing | null): PhonePing {
  const { latitude: lat, longitude: lng, speed, heading, accuracy, altitude } = position.coords
  let kmh = speed !== null && Number.isFinite(speed) && speed >= 0 ? speed * 3.6 : null
  if (kmh === null && previous) {
    const seconds = (position.timestamp - Date.parse(previous.recorded_at)) / 1000
    kmh = seconds > 0 ? (distanceM(previous, { lat, lng }) / seconds) * 3.6 : 0
  }
  return {
    recorded_at: new Date(position.timestamp).toISOString(),
    lat,
    lng,
    speed_kmh: clamp(round1(kmh ?? 0), 0, 300),
    heading: heading !== null && Number.isFinite(heading) && heading >= 0 && heading <= 360 ? round1(heading) : null,
    accuracy_m: Number.isFinite(accuracy) ? round1(accuracy) : null,
    altitude_m: altitude !== null && Number.isFinite(altitude) && altitude >= -1000 && altitude <= 10_000 ? round1(altitude) : null,
  }
}

/**
 * Watches the position while `track(true)`, and sends what is on the phone every SEND_EVERY_MS for as long as
 * it runs: a trip that ended in a dead zone still gets its last stretch once there is signal (the server files
 * each ping under the trip it was recorded in, FMS-124).
 */
export class PhoneGpsBroadcaster {
  private watchId: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private last: PhonePing | null = null
  private sending = false
  /** When the last request went, sent or not. */
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private status: GpsStatus = { state: 'off', waiting: 0, lastSentAt: null, dropped: 0 }
  private readonly listeners = new Set<(s: GpsStatus) => void>()
  private readonly now: () => number
  private readonly maxAccuracyM: number

  constructor(private readonly deps: BroadcasterDeps) {
    this.now = deps.now ?? Date.now
    this.maxAccuracyM = deps.maxAccuracyM ?? MAX_ACCURACY_M
  }

  /** Starts the sending loop; what was left on the phone from last time goes at once. */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.flush(), TICK_MS)
    void this.flush()
  }

  stop(): void {
    this.track(false)
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** Watch the position (a trip under way) or stop watching (the trip ended, or none). */
  track(on: boolean): void {
    if (on && this.watchId === null) {
      const geo = this.deps.geolocation
      if (typeof geo?.watchPosition !== 'function') return this.update({ state: 'unavailable' })
      this.last = null
      this.update({ state: 'starting', dropped: 0 })
      try {
        this.watchId = geo.watchPosition(
          (position) => void this.onReading(position),
          (error) => this.onError(error),
          { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
        )
      } catch {
        // An insecure page (http other than localhost) or a browser without location.
        this.update({ state: 'unavailable' })
      }
    } else if (!on && this.watchId !== null) {
      this.deps.geolocation?.clearWatch(this.watchId)
      this.watchId = null
      this.update({ state: 'off' })
    } else if (!on) {
      this.update({ state: 'off' })
    }
  }

  /** After the driver allowed location in the browser's settings: ask again. */
  retry(): void {
    if (this.watchId !== null) this.deps.geolocation?.clearWatch(this.watchId)
    this.watchId = null
    this.track(true)
  }

  subscribe(listener: (s: GpsStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.status)
    return () => this.listeners.delete(listener)
  }

  current(): GpsStatus {
    return this.status
  }

  private async onReading(position: GeolocationPosition): Promise<void> {
    if (this.watchId === null) return
    if (!(position.coords.accuracy <= this.maxAccuracyM)) {
      this.update({ dropped: this.status.dropped + 1, state: this.status.state === 'on' ? 'on' : 'weak' })
      return
    }
    if (this.last && position.timestamp - Date.parse(this.last.recorded_at) < KEEP_EVERY_MS) {
      if (this.status.state !== 'on') this.update({ state: 'on' })
      return
    }
    const ping = toPing(position, this.last)
    this.last = ping
    this.update({ state: 'on', waiting: this.status.waiting + 1 })
    await this.deps.buffer.add(ping)
    await this.flush()
  }

  private onError(error: GeolocationPositionError): void {
    if (error.code === error.PERMISSION_DENIED) {
      if (this.watchId !== null) this.deps.geolocation?.clearWatch(this.watchId)
      this.watchId = null
      this.update({ state: 'denied' })
    } else if (error.code === error.POSITION_UNAVAILABLE) {
      this.update({ state: 'unavailable' })
    }
    // TIMEOUT: no fix yet (a garage, a tunnel); the watch keeps trying.
  }

  /**
   * Sends the oldest batch, if SEND_EVERY_MS have passed since the last request: one request at most. Taken by the server (202): gone from the phone,
   * whatever it accepted, kept as a duplicate or refused alone. Refused whole for good (a 4xx such as 403
   * no_trip_under_way): gone too, or the phone would retry it forever. No signal, a 5xx, 429 or a session to
   * renew: kept for the next call.
   */
  async flush(): Promise<void> {
    if (this.sending || this.now() - this.lastAttemptAt < SEND_EVERY_MS) return
    this.sending = true
    try {
      if (!this.deps.online()) return
      const batch = await this.deps.buffer.oldest(MAX_BATCH)
      if (batch.length === 0) return this.update({ waiting: 0 })
      this.lastAttemptAt = this.now()
      let outcome: ReturnType<typeof outcomeOf>
      try {
        await this.deps.send(batch.map((b) => b.ping))
        outcome = { kind: 'delivered' }
      } catch (err) {
        outcome = err instanceof ApiError ? outcomeOf(err.status, err.code, err.message) : { kind: 'retry' }
      }
      if (outcome.kind === 'delivered' || outcome.kind === 'rejected') await this.deps.buffer.remove(batch.map((b) => b.seq))
      this.update({ waiting: await this.deps.buffer.count(), ...(outcome.kind === 'delivered' ? { lastSentAt: this.now() } : {}) })
    } catch {
      // IndexedDB unavailable (private mode, storage cleared): the next call tries again.
    } finally {
      this.sending = false
    }
  }

  private update(change: Partial<GpsStatus>): void {
    this.status = { ...this.status, ...change }
    for (const listener of this.listeners) listener(this.status)
  }
}
