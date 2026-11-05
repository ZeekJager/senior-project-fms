import { Skeleton } from '@/components/ui'
import { DOWNTIME_REASONS, type DowntimeReason } from './api'
import { hours, REASONS } from './describe'

/**
 * Downtime by reason (FMS-142): one bar per reason, its hours and share written beside it, so the bar is never the
 * only way to read it. Unplanned reasons (failures, counted in MTBF and MTTR) are warm and say so; planned ones
 * and the rest are the brand colour. Largest first.
 */
export function ReasonBars({ byReason, total, isLoading }: { byReason: Record<DowntimeReason, number> | undefined; total: number | undefined; isLoading: boolean }) {
  const rows = byReason ? [...DOWNTIME_REASONS].sort((a, b) => byReason[b] - byReason[a] || DOWNTIME_REASONS.indexOf(a) - DOWNTIME_REASONS.indexOf(b)) : []
  const largest = byReason ? Math.max(...DOWNTIME_REASONS.map((r) => byReason[r])) : 0

  return (
    <section aria-labelledby="reasons-heading" className="rounded-card border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="reasons-heading" className="text-base font-semibold text-ink">
          Why vehicles were down
        </h2>
        <p className="text-xs text-ink-subtle">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-warning align-middle" aria-hidden="true" />
          Counts as a failure
        </p>
      </div>
      {isLoading || !byReason ? (
        <div className="mt-4 space-y-4" aria-busy="true">
          {DOWNTIME_REASONS.map((r) => (
            <Skeleton key={r} className="h-6 w-full" />
          ))}
        </div>
      ) : total === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">No vehicle was out of service this month.</p>
      ) : (
        <ul className="mt-4 space-y-3" aria-label="Downtime by reason">
          {rows.map((r) => {
            const minutes = byReason[r]
            const share = total ? Math.round((minutes / total) * 100) : 0
            return (
              <li key={r} className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[10rem_1fr_7.5rem]">
                <span className="truncate text-ink-muted">
                  {REASONS[r].label}
                  {REASONS[r].unplanned && <span className="sr-only"> (counts as a failure)</span>}
                </span>
                <span className="h-2.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                  {minutes > 0 && (
                    <span
                      className={`block h-full rounded-full ${REASONS[r].unplanned ? 'bg-warning' : 'bg-brand'}`}
                      style={{ width: `${Math.max(2, (minutes / largest) * 100)}%` }}
                    />
                  )}
                </span>
                <span className="tabular text-right text-ink">
                  {minutes > 0 ? hours(minutes) : '—'}
                  {minutes > 0 && <span className="ml-1.5 text-xs text-ink-subtle">{share}%</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
