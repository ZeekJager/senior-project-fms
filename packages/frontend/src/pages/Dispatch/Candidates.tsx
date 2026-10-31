import { CalendarClock, Check, Clock, Truck, UserRound, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge, cn, Skeleton } from '@/components/ui'
import { driverLook, formatTime, reasonText, VEHICLE_TYPE_LABELS, vehicleLook } from './format'
import type { AvailabilityResult, BoardDriver, BoardVehicle, DriverState, VehicleState } from './types'

// The right panel: the depot's drivers and vehicles, with the card's colours.
// Every one stays selectable: the API is the last word on what can be
// assigned, and an absent driver is a warning, not a block.

const DRIVER_ORDER: DriverState[] = ['idle', 'near_end', 'absent', 'unavailable', 'en_route']
const VEHICLE_ORDER: VehicleState[] = ['idle', 'unavailable', 'en_route', 'flagged']

export const sortDrivers = (drivers: BoardDriver[]) =>
  [...drivers].sort((a, b) => DRIVER_ORDER.indexOf(a.state) - DRIVER_ORDER.indexOf(b.state) || a.full_name.localeCompare(b.full_name))
export const sortVehicles = (vehicles: BoardVehicle[]) =>
  [...vehicles].sort((a, b) => VEHICLE_ORDER.indexOf(a.state) - VEHICLE_ORDER.indexOf(b.state) || a.registration_number.localeCompare(b.registration_number))

/** Reasons that matter for this trip, other than the one the state badge already says. */
function reasonsLine(availability: AvailabilityResult, hide: string[]): string | null {
  const shown = availability.reasons.map((r) => r.code).filter((c) => !hide.includes(c))
  return shown.length > 0 ? [...new Set(shown.map(reasonText))].join(' · ') : null
}

function Row({ selected, onSelect, label, icon, title, subtitle, badge, detail }: { selected: boolean; onSelect: () => void; label: string; icon: ReactNode; title: string; subtitle: string; badge: ReactNode; detail: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={label}
        onClick={onSelect}
        className={cn(
          'flex w-full items-start gap-3 rounded-control border px-3 py-2.5 text-left transition',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          selected ? 'border-brand bg-brand-soft' : 'border-transparent hover:border-line hover:bg-surface-muted',
        )}
      >
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full [&_svg]:h-4 [&_svg]:w-4',
            selected ? 'bg-brand text-white' : 'bg-surface-sunken text-ink-subtle',
          )}
          aria-hidden="true"
        >
          {selected ? <Check /> : icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink">{title}</span>
              <span className="block truncate text-xs text-ink-muted">{subtitle}</span>
            </span>
            {badge}
          </span>
          {detail}
        </span>
      </button>
    </li>
  )
}

function StateBadge({ label, tone, hint }: { label: string; tone: Parameters<typeof Badge>[0]['tone']; hint: string }) {
  return (
    <span title={hint} className="shrink-0">
      <Badge tone={tone} dot>
        {label}
      </Badge>
    </span>
  )
}

function Detail({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return <span className="mt-1 flex items-center gap-1 text-xs text-ink-muted [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}{children}</span>
}

export function DriverList({ drivers, selectedId, onSelect }: { drivers: BoardDriver[]; selectedId: string | null; onSelect: (d: BoardDriver) => void }) {
  return (
    <ul className="space-y-1" aria-label="Drivers">
      {sortDrivers(drivers).map((d) => {
        const look = driverLook(d)
        const reasons = reasonsLine(d.availability, ['driver_absent', 'driver_on_leave', 'driver_sick'])
        return (
          <Row
            key={d.driver_id}
            selected={d.driver_id === selectedId}
            onSelect={() => onSelect(d)}
            label={`${d.full_name}, ${look.label}`}
            icon={<UserRound />}
            title={d.full_name}
            subtitle={d.license_categories.length > 0 ? `Licence ${d.license_categories.join(', ')}` : 'No licence class on file'}
            badge={<StateBadge {...look} />}
            detail={
              <>
                {d.current_trip && <Detail icon={<Clock />}>On a trip until {formatTime(d.current_trip.end)}</Detail>}
                {reasons && <Detail>{reasons}</Detail>}
              </>
            }
          />
        )
      })}
    </ul>
  )
}

export function VehicleList({ vehicles, selectedId, onSelect }: { vehicles: BoardVehicle[]; selectedId: string | null; onSelect: (v: BoardVehicle) => void }) {
  return (
    <ul className="space-y-1" aria-label="Vehicles">
      {sortVehicles(vehicles).map((v) => {
        const look = vehicleLook(v.state)
        const reasons = reasonsLine(v.availability, ['maintenance_flag', 'vehicle_in_maintenance'])
        return (
          <Row
            key={v.vehicle_id}
            selected={v.vehicle_id === selectedId}
            onSelect={() => onSelect(v)}
            label={`${v.registration_number}, ${look.label}`}
            icon={<Truck />}
            title={v.registration_number}
            subtitle={`${VEHICLE_TYPE_LABELS[v.vehicle_type] ?? v.vehicle_type} · ${v.make} ${v.model}`}
            badge={<StateBadge {...look} />}
            detail={
              <>
                {v.open_work && <Detail icon={<Wrench />}>{v.open_work.description}</Detail>}
                {v.service_due && (
                  <span className={cn('mt-1 flex items-center gap-1 text-xs font-medium [&_svg]:h-3.5 [&_svg]:w-3.5', v.service_due.status === 'overdue' ? 'text-danger' : 'text-warning')}>
                    <CalendarClock aria-hidden="true" />
                    {v.service_due.status === 'overdue' ? 'Service overdue' : 'Service due'}: {v.service_due.programs.map((p) => p.name).join(', ')}
                  </span>
                )}
                {v.current_trip && <Detail icon={<Clock />}>On a trip until {formatTime(v.current_trip.end)}</Detail>}
                {reasons && <Detail>{reasons}</Detail>}
              </>
            }
          />
        )
      })}
    </ul>
  )
}

export function CandidatesSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  )
}
