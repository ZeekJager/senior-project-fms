import { ArrowRight, History, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState, ErrorState } from '@/components/shared'
import { Badge, Drawer, Skeleton } from '@/components/ui'
import { monthLabel } from '@/lib/month'
import { useVehiclePeriods, type DowntimePeriod, type VehicleAvailability } from './api'
import { failureLabel, hours, minutesInMonth, openedByLabel, pct, recordLabel, REASONS, span, when } from './describe'

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="tabular mt-0.5 text-base font-semibold text-ink">{value}</dd>
    </div>
  )
}

/** One period: when, how long (and how much of it in the month), its reason, and the problem behind it. */
function Period({ period, month }: { period: DowntimePeriod; month: string }) {
  const inMonth = minutesInMonth(period, month)
  const reason = REASONS[period.reason]
  const failure = period.failure ? failureLabel(period.failure) : null
  return (
    <li className="rounded-card border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="tabular text-sm font-medium text-ink">
            {when(period.started_at)}
            <ArrowRight className="mx-1.5 inline h-3.5 w-3.5 text-ink-subtle" aria-label="to" />
            {period.ended_at ? when(period.ended_at) : 'still out of service'}
          </p>
          <p className="tabular mt-0.5 text-xs text-ink-subtle">
            {span(period.duration_minutes)}
            {inMonth !== period.duration_minutes && ` · ${hours(inMonth)} in ${monthLabel(month)}`}
          </p>
        </div>
        <Badge tone={reason.tone}>{reason.label}</Badge>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        {period.maintenance_record && (
          <div>
            <dt className="text-xs font-medium text-ink-muted">Work order</dt>
            <dd className="text-ink [overflow-wrap:anywhere]">
              {recordLabel(period.maintenance_record)}
              {period.maintenance_record.status !== 'completed' && <span className="ml-1.5 text-xs text-ink-subtle">({period.maintenance_record.status.replace(/_/g, ' ')})</span>}
            </dd>
          </div>
        )}
        {failure && (
          <div>
            <dt className="text-xs font-medium text-ink-muted">Failure</dt>
            <dd className="text-ink">
              {failure.what}
              <span className="block text-xs text-ink-subtle">{failure.found}</span>
            </dd>
          </div>
        )}
        {!period.maintenance_record && !failure && (
          <div>
            <dt className="text-xs font-medium text-ink-muted">Began with</dt>
            <dd className="text-ink">{openedByLabel(period)}</dd>
          </div>
        )}
        {period.reason !== period.derived_reason && (
          <div>
            <dt className="text-xs font-medium text-ink-muted">Reason set by staff</dt>
            <dd className="text-ink [overflow-wrap:anywhere]">
              {period.reason_note ?? `${reason.label}, instead of ${REASONS[period.derived_reason].label.toLowerCase()}`}
            </dd>
          </div>
        )}
      </dl>
    </li>
  )
}

/**
 * A vehicle's month (S-33, FMS-142): its figures, and each downtime period with the work order or failure behind it,
 * newest first. Opens the vehicle's history (S-22) for the full record.
 */
export function PeriodsDrawer({ vehicle, month, onClose }: { vehicle: VehicleAvailability | null; month: string; onClose: () => void }) {
  const periods = useVehiclePeriods(vehicle?.vehicle_id ?? '', month)
  if (!vehicle) return null

  return (
    <Drawer
      open
      onClose={onClose}
      title={vehicle.registration_number}
      description={`${vehicle.depot_name} · ${monthLabel(month)}`}
      footer={
        <div className="flex justify-end">
          <Link to={`/vehicles/${vehicle.vehicle_id}`} className="focus-ring inline-flex items-center gap-2 rounded-control px-3 py-2 text-sm font-medium text-brand-ink hover:bg-brand-soft">
            <History className="h-4 w-4" aria-hidden="true" />
            Open vehicle history
          </Link>
        </div>
      }
    >
      <div className="space-y-6">
        <dl className="grid grid-cols-2 gap-4 rounded-card border border-line bg-surface-muted p-4 sm:grid-cols-4">
          <Figure label="Available" value={pct(vehicle.availability_pct)} />
          <Figure label="Down" value={hours(vehicle.downtime_minutes)} />
          <Figure label="MTBF" value={span(vehicle.mtbf_minutes)} />
          <Figure label="MTTR" value={span(vehicle.mttr_minutes)} />
        </dl>

        <section aria-labelledby="periods-heading" className="space-y-3">
          <h3 id="periods-heading" className="text-sm font-semibold text-ink">
            Downtime periods
            {periods.data && <span className="ml-1.5 font-normal text-ink-subtle">{periods.data.total}</span>}
          </h3>
          {periods.isPending ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : periods.isError ? (
            <ErrorState error={periods.error} onRetry={() => void periods.refetch()} />
          ) : periods.data.periods.length === 0 ? (
            <EmptyState icon={<Wrench />} heading="Not out of service this month" description="No downtime period overlaps the month." />
          ) : (
            <ul className="space-y-3">
              {periods.data.periods.map((p) => (
                <Period key={p.id} period={p} month={month} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  )
}
