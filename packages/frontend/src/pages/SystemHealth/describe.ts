// How S-31 words its figures: Addis Ababa times, durations, latencies and shares.

const TZ = 'Africa/Addis_Ababa'
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' })
const whenFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** 14:05 */
export const clock = (iso: string) => clockFormat.format(new Date(iso))
/** 4 Nov, 14:05 */
export const when = (iso: string) => whenFormat.format(new Date(iso))

/** A chart cell's label: its time within a day, its day and time over a week or a month. */
export function cellLabel(iso: string, bucketMinutes: number): string {
  if (bucketMinutes < 60) return clock(iso)
  return `${dayFormat.format(new Date(iso))} ${clock(iso)}`
}

/** 14:00–14:15, or 4 Nov 08:00–16:00 */
export function cellRange(iso: string, bucketMinutes: number): string {
  const end = new Date(Date.parse(iso) + bucketMinutes * 60_000).toISOString()
  return `${cellLabel(iso, bucketMinutes)}–${clock(end)}`
}

/** 3 min, 2 h 5 min, 1 d 4 h */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`
}

/** 85 ms, 1.2 s, ≥ 10 s */
export function milliseconds(ms: number | null): string {
  if (ms === null) return '—'
  if (ms >= 10_000) return '≥ 10 s'
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 9950 ? 0 : 1)} s`
  return `${Math.round(ms)} ms`
}

/** 99.95%, or — when there is nothing to divide. */
export const percentText = (pct: number | null) => (pct === null ? '—' : `${pct.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`)
