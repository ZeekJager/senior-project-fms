import { formatMinor } from '@/components/shared'

// How S-18 (FMS-51) says its figures: integers from the API, formatted here and nowhere else.

/** Whole birr, grouped: "ETB 12,346" (from cents, rounded half away from zero). */
export const birr = (cents: number) => `ETB ${formatMinor(cents, 2, 0)}`

/** Birr and cents per km: "ETB 1.00", or a dash with nothing driven. */
export const birrPerKm = (cents: number | null) => (cents === null ? '—' : `ETB ${formatMinor(cents, 2)}`)

/** Whole litres from ml: "1,235 L". */
export const litres = (ml: number) => `${formatMinor(ml, 3, 0)} L`

/** A percentage, or a dash when there is nothing to divide by. */
export const percent = (pct: number | null) => (pct === null ? '—' : `${pct}%`)

/** "12 Oct" for a YYYY-MM-DD day. */
export const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** "14:05" in Addis Ababa. */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Addis_Ababa' })

/** "3 hours ago", "2 days ago": how old the last refresh is. */
export function ago(iso: string, now = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `${days} days ago`
}

/** "17 Oct 2026" for a YYYY-MM-DD day (chart tooltips). */
export const longDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
