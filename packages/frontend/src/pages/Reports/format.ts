import type { ColumnKind, ReportColumn, ReportValue } from './api'

// How a report's values read on screen (FMS-91): the units are in the column labels, so the cells are numbers with
// thousands separators; times in Addis Ababa. The CSV and PDF are written by the server.

const decimals = (value: number, divisor: number, places: number) =>
  (value / divisor).toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })

const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** A cell as the preview shows it; "—" for nothing. */
export function displayValue(kind: ColumnKind, value: ReportValue): string {
  if (value === null || value === '') return '—'
  if (typeof value === 'string') return kind === 'datetime' ? when.format(new Date(value)) : value
  switch (kind) {
    case 'litres':
    case 'km':
      return decimals(value, 1000, 1)
    case 'etb':
      return decimals(value, 100, 2)
    case 'l_per_100km':
      return decimals(value, 10, 1)
    case 'hours':
      return decimals(value, 60, 1)
    default:
      return value.toLocaleString('en-US')
  }
}

/** Numbers sit right, as in a spreadsheet. */
export const isNumeric = (kind: ColumnKind) => kind !== 'text' && kind !== 'datetime'

/** Places, people and routes need room; a figure fits in a little. Whole class names, so Tailwind finds them. */
const TEXT_WIDTHS: Record<string, string> = {
  route: 'w-[14rem]',
  depot: 'w-[11rem]',
  driver: 'w-[11rem]',
  registration_number: 'w-[8.5rem]',
  fuel_type: 'w-[6.5rem]',
  status: 'w-[7rem]',
  on_time: 'w-[5.5rem]',
}

/** A column's width class in the preview table (fixed layout: their sum sets the table's width when wider than the screen). */
export function columnWidth(column: Pick<ReportColumn, 'key' | 'kind'>): string {
  if (column.kind === 'datetime') return 'w-[8.5rem]'
  // The driver's rank is short; the score cell may read "Not enough trips" (FMS-146).
  if (column.key === 'rank') return 'w-[4.5rem]'
  if (column.key === 'score') return 'w-[9rem]'
  if (!isNumeric(column.kind)) return TEXT_WIDTHS[column.key] ?? 'w-[10rem]'
  return column.kind === 'count' ? 'w-[6.5rem]' : 'w-[7.5rem]'
}
