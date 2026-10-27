import { CALENDAR_KEY, getPreference, type CalendarSystem } from '@/lib/preferences'

// The vehicle page reads times in Addis Ababa, 24-hour clock, in the calendar the user chose.
const TZ = 'Africa/Addis_Ababa'

function locale(): string {
  return getPreference<CalendarSystem>(CALENDAR_KEY, 'gregorian') === 'ethiopic' ? 'en-u-ca-ethiopic' : 'en-GB'
}

/** "2 Oct 2026, 09:40". */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(locale(), { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "2 Oct 2026". */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(locale(), { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' })
}

/** "09:40". */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
}

/** "5 h 20 min", "45 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** "312 km", "87,000.5 km". */
export function formatKm(km: number): string {
  return `${km.toLocaleString('en-US', { maximumFractionDigits: 1 })} km`
}
