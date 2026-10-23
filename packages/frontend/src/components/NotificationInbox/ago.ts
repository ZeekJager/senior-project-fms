const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago, the way a bell panel says it: "Just now", "5 min ago", "3 h ago", "2 d ago", and a date from a
 * week on (the inbox holds 30 days). Whole units, rounded down, so a label never reads as later than it is.
 * A clock a little behind the server's reads as "Just now", never as the future.
 */
export function ago(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < MINUTE) return 'Just now'
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)} min ago`
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)} h ago`
  if (seconds < 7 * DAY) return `${Math.floor(seconds / DAY)} d ago`
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Addis_Ababa' })
}
