import { AlertTriangle, Bus, Gauge, ShieldAlert, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn, Skeleton } from '@/components/ui'
import type { Overview } from './overview'

// The command center's counters (FMS-89): the fleet, the drivers, the day's trips and what needs attention,
// from GET /command-center/overview. A section the user may not read is left out, not shown as zero.

interface Figure {
  label: string
  value: number
  /** Draws the eye when not zero: overdue trips, critical alerts. */
  alarm?: boolean
  /** Opens the panel that lists them. */
  onClick?: () => void
}

function Group({ icon, title, figures }: { icon: ReactNode; title: string; figures: Figure[] }) {
  return (
    <section aria-label={title} className="min-w-0 rounded-card border border-line bg-surface px-4 py-3 shadow-soft">
      <h2 className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        <span className="text-ink-subtle [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">
          {icon}
        </span>
        {title}
      </h2>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
        {figures.map((f) => {
          const loud = f.alarm && f.value > 0
          const body = (
            <>
              <span className={cn('tabular block text-lg font-semibold leading-none', loud ? 'text-danger' : 'text-ink')}>{f.value}</span>
              <span className={cn('mt-1 block text-xs', loud ? 'font-medium text-danger' : 'text-ink-subtle')}>{f.label}</span>
            </>
          )
          return (
            <li key={f.label}>
              {f.onClick ? (
                <button
                  type="button"
                  onClick={f.onClick}
                  className="focus-ring -mx-1.5 -my-1 block rounded-control px-1.5 py-1 text-left transition-colors duration-150 hover:bg-surface-muted coarse:min-h-11"
                >
                  {body}
                </button>
              ) : (
                body
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function StatusStrip({ overview, isLoading, onShowAlerts, onShowIncidents }: { overview: Overview | undefined; isLoading: boolean; onShowAlerts: () => void; onShowIncidents: () => void }) {
  if (isLoading && !overview) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[84px] w-full" />
        ))}
      </div>
    )
  }
  if (!overview) return null
  const { vehicles, drivers, trips, alerts, incidents } = overview
  const attention: Figure[] = []
  if (alerts) attention.push({ label: alerts.by_severity.critical > 0 ? `Alerts · ${alerts.by_severity.critical} critical` : 'Alerts', value: alerts.active, alarm: alerts.by_severity.critical > 0, onClick: onShowAlerts })
  if (incidents) attention.push({ label: 'Incidents', value: incidents.active, alarm: incidents.by_severity.critical > 0, onClick: onShowIncidents })
  attention.push({ label: 'Health at risk', value: vehicles.health.at_risk, alarm: true })

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Group
        icon={<Bus />}
        title="Vehicles"
        figures={[
          { label: 'On a trip', value: vehicles.on_trip },
          { label: 'Available', value: vehicles.available },
          { label: 'In the workshop', value: vehicles.in_maintenance },
          { label: 'Flagged', value: vehicles.flagged, alarm: true },
        ]}
      />
      {drivers && (
        <Group
          icon={<UserRound />}
          title="Drivers"
          figures={[
            { label: 'On a trip', value: drivers.on_trip },
            { label: 'Available', value: drivers.available },
            { label: 'Absent today', value: drivers.absent },
            ...(drivers.licence_expired > 0 ? [{ label: 'Licence expired', value: drivers.licence_expired, alarm: true }] : []),
          ]}
        />
      )}
      {trips && (
        <Group
          icon={<Gauge />}
          title="Trips today"
          figures={[
            { label: 'Under way', value: trips.under_way },
            { label: 'Overdue', value: trips.overdue, alarm: true },
            { label: 'Still to start', value: trips.today.scheduled + trips.today.assigned },
            { label: 'Completed', value: trips.today.completed },
          ]}
        />
      )}
      <Group icon={alerts && alerts.by_severity.critical > 0 ? <ShieldAlert /> : <AlertTriangle />} title="Needs attention" figures={attention} />
    </div>
  )
}
