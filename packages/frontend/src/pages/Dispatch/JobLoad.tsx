import { Gauge, Package } from 'lucide-react'
import { Badge, Button, type BadgeTone } from '@/components/ui'
import { cargoSummary, JOB_LOAD_LABELS, jobLoadReason } from './cargo'
import type { JobLoad, Trip } from './types'

const TONES: Record<JobLoad, BadgeTone> = { light: 'neutral', standard: 'info', heavy: 'warning' }

/** The job's load as a badge (FMS-153): light, standard or heavy. */
export function JobLoadBadge({ load }: { load: JobLoad }) {
  return (
    <Badge tone={TONES[load]} icon={<Gauge />}>
      {JOB_LOAD_LABELS[load]}
    </Badge>
  )
}

/**
 * What the job asks of its driver, and why (FMS-153), with what it carries. The load is the API's, worked out from
 * the route, the times and the cargo: the dispatcher changes the cargo, never the load.
 */
export function JobLoadDetails({ trip, onChangeCargo }: { trip: Trip; onChangeCargo?: () => void }) {
  if (!trip.job_load) return null
  const reasons = trip.job_load_reasons ?? []
  return (
    <div role="group" aria-label="Job load" className="mt-4 rounded-control border border-line bg-surface-muted px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <JobLoadBadge load={trip.job_load} />
        {onChangeCargo && (
          <Button variant="secondary" size="sm" leadingIcon={<Package className="h-4 w-4" />} onClick={onChangeCargo}>
            Change cargo
          </Button>
        )}
      </div>
      <p className="mt-2 text-sm text-ink">{reasons.length > 0 ? reasons.map(jobLoadReason).join(' · ') : 'A short day job: nothing adds to it.'}</p>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
        <Package className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />
        <span>
          <span className="sr-only">Cargo: </span>
          {cargoSummary(trip)}
        </span>
      </p>
    </div>
  )
}
