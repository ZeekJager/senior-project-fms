import { Dialog } from '@/components/ui'
import { CALENDAR_KEY, usePreference, type CalendarSystem } from '@/lib/preferences'

const SHORTCUTS: [string, string][] = [
  ['/', 'Jump to the search box'],
  ['J / K', 'Move down / up the rows of a list'],
  ['Enter', 'Open the marked row'],
  ['Esc', 'Let go of a row, or close a panel'],
  ['?', 'Open this help'],
]

const TERMS: [string, string][] = [
  ['Ready to dispatch', 'Active, not flagged, not on a trip and with no expired document.'],
  ['Flagged', 'Marked as needing maintenance. It can still be dispatched, but someone should look.'],
  ['Workshop', 'Currently in maintenance.'],
  ['Documents due', 'A document has expired or expires within 30 days.'],
  ['Expiring soon', 'A licence that expires within 30 days.'],
  ['Retired / Inactive', 'Kept for the record, out of everyday lists.'],
  ['Locked', 'Locked after too many failed sign-ins; an admin can unlock it.'],
]

/** Keyboard shortcuts, the words this system uses, and the calendar choice. */
export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [calendar, setCalendar] = usePreference<CalendarSystem>(CALENDAR_KEY, 'gregorian')
  return (
    <Dialog open={open} onClose={onClose} title="Help" description="Shortcuts, terms and display choices." className="!max-w-lg">
      <div className="max-h-[60vh] space-y-6 overflow-y-auto pr-1">
        <section aria-labelledby="help-keys">
          <h3 id="help-keys" className="text-sm font-semibold text-ink">
            Keyboard shortcuts
          </h3>
          <dl className="mt-2 divide-y divide-line text-sm">
            {SHORTCUTS.map(([key, what]) => (
              <div key={key} className="flex items-center justify-between gap-4 py-2">
                <dt>
                  <kbd className="rounded border border-line-strong px-1.5 py-0.5 text-xs font-medium text-ink">{key}</kbd>
                </dt>
                <dd className="text-ink-muted">{what}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-labelledby="help-terms">
          <h3 id="help-terms" className="text-sm font-semibold text-ink">
            What the words mean
          </h3>
          <dl className="mt-2 space-y-2 text-sm">
            {TERMS.map(([term, meaning]) => (
              <div key={term}>
                <dt className="font-medium text-ink">{term}</dt>
                <dd className="text-ink-muted">{meaning}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h3 id="help-calendar" className="text-sm font-semibold text-ink">
            Calendar
          </h3>
          <p className="mt-1 text-sm text-ink-muted">How dates are shown, such as document and licence expiry. Stored dates do not change.</p>
          <div role="radiogroup" aria-labelledby="help-calendar" className="mt-2 flex gap-2">
            {(
              [
                ['gregorian', 'Gregorian'],
                ['ethiopic', 'Ethiopian'],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2 rounded-control border border-line-strong px-3 py-2 text-sm text-ink focus-within:ring-2 focus-within:ring-focus has-[:checked]:border-brand has-[:checked]:bg-brand-soft coarse:min-h-11"
              >
                <input type="radio" name="calendar" value={value} checked={calendar === value} onChange={() => setCalendar(value)} className="accent-[rgb(var(--c-brand))]" />
                {label}
              </label>
            ))}
          </div>
        </section>
      </div>
    </Dialog>
  )
}
