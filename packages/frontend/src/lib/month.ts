// Calendar months in Addis Ababa, as the monthly screens read them (fuel reconciliation, reports).

/** A calendar month, `YYYY-MM`. */
export type Month = string

const pad = (n: number) => String(n).padStart(2, '0')

/** This month in Addis Ababa (UTC+3 all year). */
export function currentMonth(now = new Date()): Month {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 7)
}

export function shiftMonth(month: Month, by: number): Month {
  const [y, m] = month.split('-').map(Number)
  const index = y * 12 + (m - 1) + by
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`
}

/** The month's first and last day, as the API's inclusive date bounds. */
export function monthBounds(month: Month): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${pad(last)}` }
}

/** "September 2026". */
export function monthLabel(month: Month): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}
