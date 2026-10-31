import { AlertCircle, ArrowUpRight, CalendarCheck2, CalendarClock, Wrench } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/shared'
import { Badge, Button, Skeleton } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { ServiceDueBadge, dueText, useVehicleServiceDue, type ServiceDue } from '@/features/service-due'
import { LogRepairDrawer, type RepairPreset } from '@/pages/Maintenance'
import type { Vehicle } from '@/pages/Vehicles/types'
import { formatDay, formatKm } from './format'

/**
 * Service due (FMS-129) on the vehicle's own page: each service program covering it, most urgent first,
 * with when each measure falls due, the last service and a job card to log the next.
 */
export function ServiceDueSection({ vehicle }: { vehicle: Vehicle }) {
  const { hasPermission } = useAuth()
  const due = useVehicleServiceDue(vehicle.id)
  const [preset, setPreset] = useState<RepairPreset | null>(null)
  const canLog = hasPermission('maintenance:write') && vehicle.status !== 'retired'

  return (
    <section aria-labelledby="service-heading" className="max-w-3xl space-y-4">
      <div>
        <h2 id="service-heading" className="text-base font-semibold text-ink">
          Service due
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">Its scheduled service, by kilometres, days or engine hours, whichever comes first.</p>
      </div>
      {due.isError ? (
        <p role="alert" className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          The service due could not be loaded. Reload the page to try again.
        </p>
      ) : due.isPending ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-24 w-full rounded-card" />
          <Skeleton className="h-24 w-full rounded-card" />
        </div>
      ) : due.data.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          heading="No service program covers it"
          description="Service programs say how often each kind of vehicle is serviced. None matches this vehicle yet."
          headingLevel="h3"
          action={
            hasPermission('maintenance:read') && (
              <Link to="/service-programs" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-ink hover:underline">
                Service programs
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )
          }
        />
      ) : (
        <ul className="space-y-3">
          {due.data.map((d) => (
            <ProgramCard
              key={d.program.id}
              due={d}
              onLog={
                canLog && !d.open_record
                  ? () =>
                      setPreset({
                        vehicle: { id: vehicle.id, registration_number: vehicle.registration_number },
                        type: 'preventive',
                        description: d.program.tasks.length ? `${d.program.name}: ${d.program.tasks.join(', ')}` : d.program.name,
                        programId: d.program.id,
                      })
                  : undefined
              }
            />
          ))}
        </ul>
      )}
      {preset && <LogRepairDrawer open onClose={() => setPreset(null)} canInventory={hasPermission('inventory:read')} preset={preset} />}
    </section>
  )
}

function ProgramCard({ due, onLog }: { due: ServiceDue; onLog?: () => void }) {
  const next = [
    due.next_due.odometer_km !== null ? formatKm(due.next_due.odometer_km) : null,
    due.next_due.at ? formatDay(due.next_due.at) : null,
    due.next_due.engine_hours !== null ? `${due.next_due.engine_hours.toLocaleString('en-US')} engine hours` : null,
  ].filter(Boolean)
  return (
    <li className="rounded-card border border-line bg-surface p-4 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
            {due.program.name}
            <ServiceDueBadge status={due.status} />
            {due.open_record && (
              <Badge tone="info" icon={<CalendarCheck2 aria-hidden="true" />}>
                Booked
              </Badge>
            )}
          </p>
          <p className="mt-1 text-sm text-ink">{dueText(due)}</p>
        </div>
        {onLog && (
          <Button size="sm" variant="secondary" leadingIcon={<Wrench className="h-3.5 w-3.5" />} onClick={onLog} aria-label={`Log ${due.program.name}`}>
            Log service
          </Button>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-ink-subtle">Next due</dt>
          <dd className="tabular text-ink-muted">{next.join(' · ') || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">Last service</dt>
          <dd className="text-ink-muted">
            {due.last_service ? formatDay(due.last_service.completed_at) : `None on record: counted from ${formatDay(due.since.at)} at ${formatKm(due.since.odometer_km)}`}
          </dd>
        </div>
      </dl>
      {due.program.tasks.length > 0 && <p className="mt-3 text-xs text-ink-subtle">Checklist: {due.program.tasks.join(', ')}</p>}
    </li>
  )
}
