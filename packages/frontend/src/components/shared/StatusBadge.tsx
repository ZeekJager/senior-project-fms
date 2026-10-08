/**
 * The status vocabulary and its one colour per status. Adding a status to
 * STATUSES without a STATUS_STYLES entry is a compile error (the record is
 * exhaustive) and also changes the snapshot in StatusBadge.test.tsx, so a
 * status can never appear on one screen in a colour another screen lacks.
 */
export const STATUSES = ['draft', 'scheduled', 'assigned', 'en_route', 'completed', 'cancelled', 'flagged'] as const

export type Status = (typeof STATUSES)[number]

interface StatusStyle {
  /** Name of the colour, so the vocabulary is readable without Tailwind classes. */
  colour: 'grey' | 'blue' | 'yellow' | 'green' | 'red' | 'orange'
  label: string
  /** Complete class names: Tailwind only generates classes it finds written out in full. */
  classes: string
}

export const STATUS_STYLES: Record<Status, StatusStyle> = {
  draft: { colour: 'grey', label: 'Draft', classes: 'bg-slate-100 text-slate-800' },
  scheduled: { colour: 'grey', label: 'Scheduled', classes: 'bg-slate-100 text-slate-800' },
  assigned: { colour: 'blue', label: 'Assigned', classes: 'bg-blue-100 text-blue-800' },
  en_route: { colour: 'yellow', label: 'En route', classes: 'bg-yellow-100 text-yellow-900' },
  completed: { colour: 'green', label: 'Completed', classes: 'bg-green-100 text-green-800' },
  cancelled: { colour: 'red', label: 'Cancelled', classes: 'bg-red-100 text-red-800' },
  flagged: { colour: 'orange', label: 'Flagged', classes: 'bg-orange-100 text-orange-900' },
}

/** A status as a coloured pill. The label is always text, so colour is never the only signal. */
export function StatusBadge({ status }: { status: Status }) {
  const style = STATUS_STYLES[status]
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style.classes}`} data-status={status}>
      {style.label}
    </span>
  )
}
