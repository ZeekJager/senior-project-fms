/**
 * The status vocabulary and its one colour per status. Adding a status to
 * STATUSES without a STATUS_STYLES entry is a compile error (the record is
 * exhaustive) and also changes the snapshot in StatusBadge.test.tsx, so a
 * status can never appear on one screen in a colour another screen lacks.
 */
export const STATUSES = [
  // Trips
  'draft',
  'scheduled',
  'assigned',
  'en_route',
  'completed',
  'cancelled',
  'flagged',
  // Vehicles (shared.vehicle_status)
  'active',
  'inactive',
  'maintenance',
  'retired',
  'decommissioned',
] as const

export type Status = (typeof STATUSES)[number]

type Colour = 'grey' | 'blue' | 'yellow' | 'green' | 'red' | 'orange'

interface StatusStyle {
  /** Name of the colour, so the vocabulary is readable without Tailwind classes. */
  colour: Colour
  label: string
  /** Complete class names: Tailwind only generates classes it finds written out in full. */
  classes: string
}

// A soft tint, a hairline ring and strong text: AA contrast in light and dark mode.
const COLOURS: Record<Colour, string> = {
  grey: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-400/10 dark:text-slate-300 dark:ring-slate-400/20',
  blue: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-400/10 dark:text-blue-300 dark:ring-blue-400/25',
  yellow: 'bg-yellow-50 text-yellow-800 ring-yellow-600/25 dark:bg-yellow-400/10 dark:text-yellow-300 dark:ring-yellow-400/25',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25',
  red: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-400/10 dark:text-red-300 dark:ring-red-400/25',
  orange: 'bg-orange-50 text-orange-800 ring-orange-600/20 dark:bg-orange-400/10 dark:text-orange-300 dark:ring-orange-400/25',
}

const style = (colour: Colour, label: string): StatusStyle => ({ colour, label, classes: COLOURS[colour] })

export const STATUS_STYLES: Record<Status, StatusStyle> = {
  draft: style('grey', 'Draft'),
  scheduled: style('grey', 'Scheduled'),
  assigned: style('blue', 'Assigned'),
  en_route: style('yellow', 'En route'),
  completed: style('green', 'Completed'),
  cancelled: style('red', 'Cancelled'),
  flagged: style('orange', 'Flagged'),
  active: style('green', 'Active'),
  inactive: style('grey', 'Inactive'),
  maintenance: style('orange', 'Maintenance'),
  retired: style('grey', 'Retired'),
  decommissioned: style('red', 'Decommissioned'),
}

/** A status as a coloured pill with a dot. The label is always text, so colour is never the only signal. */
export function StatusBadge({ status }: { status: Status }) {
  const { classes, label } = STATUS_STYLES[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${classes}`}
      data-status={status}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  )
}
