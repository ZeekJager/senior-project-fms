import type { BoardDistance, BoardDistancePeriod } from './types'

// The driving distance limits on the console (FMS-156, docs/driving-distance-limits.md): load-weighted km in the trip's
// day and week. Past a limit the API refuses the assignment; at 80% it is a warning.

const km = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 1 }))
const when = (p: BoardDistancePeriod['period']) => (p === 'day' ? 'today' : 'this week')

/** "Would drive 560 of 500 km today": past a limit with the trip. */
export const overText = (p: { period: 'day' | 'week'; limit_km: number; total_km?: number; with_km?: number }) =>
  `Would drive ${km(p.with_km ?? p.total_km ?? 0)} of ${km(p.limit_km)} km ${when(p.period)}`

/** "180 km left today · 900 this week": what the trip leaves of each limit. */
export const leftText = (d: BoardDistance) => `${km(Math.max(0, d.day.left_km))} km left today · ${km(Math.max(0, d.week.left_km))} this week`

/** The driver card's line, and its tone: past a limit (danger), at 80% of one (warning), or what is left. */
export function distanceLine(d: BoardDistance | null | undefined): { text: string; tone: 'danger' | 'warning' | 'muted' } | null {
  if (!d) return null
  if (d.over) return { text: overText(d.over), tone: 'danger' }
  return { text: leftText(d), tone: d.near ? 'warning' : 'muted' }
}
