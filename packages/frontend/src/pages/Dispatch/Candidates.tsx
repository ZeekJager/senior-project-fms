import { licenceText } from '@/lib/licence'
import { Activity, CalendarClock, Check, Clock, FlaskConical, Gauge, Sparkles, Truck, UserRound, Wrench } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { Badge, cn, Skeleton } from '@/components/ui'
import { driverLook, formatTime, reasonText, VEHICLE_TYPE_LABELS, vehicleLook } from './format'
import { distanceLine } from './distance'
import { rankDrivers, UNSUITABLE_TEXT } from './rankDrivers'
import { lateLine, safetyLine, tripRiskNote } from './tripRisk'
import type { AvailabilityResult, BoardDriver, BoardTripRisk, BoardVehicle, VehicleState } from './types'

// The right panel: the depot's drivers and vehicles, with the card's colours.
// Every one stays selectable: the API is the last word on what can be
// assigned, and an absent driver is a warning, not a block.

const VEHICLE_ORDER: VehicleState[] = ['idle', 'unavailable', 'en_route', 'flagged']

export const sortVehicles = (vehicles: BoardVehicle[]) =>
  [...vehicles].sort((a, b) => VEHICLE_ORDER.indexOf(a.state) - VEHICLE_ORDER.indexOf(b.state) || a.registration_number.localeCompare(b.registration_number))

/** Reasons that matter for this trip, other than the one the state badge already says. */
function reasonsLine(availability: AvailabilityResult, hide: string[]): string | null {
  const shown = availability.reasons.map((r) => r.code).filter((c) => !hide.includes(c))
  return shown.length > 0 ? [...new Set(shown.map(reasonText))].join(' · ') : null
}

function Row({
  selected,
  onSelect,
  label,
  icon,
  title,
  subtitle,
  badge,
  detail,
  rank,
}: {
  selected: boolean
  onSelect: () => void
  label: string
  icon: ReactNode
  title: string
  subtitle: string
  badge: ReactNode
  detail: ReactNode
  /** The driver's place among the suitable ones (1: the best fit). */
  rank?: number | null
}) {
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
              <span className="flex min-w-0 items-baseline gap-1.5">
                {rank != null && <span className="tabular shrink-0 text-xs font-semibold text-ink-subtle">{rank}.</span>}
                <span className="truncate text-sm font-medium text-ink">{title}</span>
                {rank === 1 && (
                  <span className="shrink-0">
                    <Badge tone="brand" icon={<Sparkles aria-hidden="true" />}>
                      Best fit
                    </Badge>
                  </span>
                )}
              </span>
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

/** Why the drivers carry no trip risk, or that it is a demonstration (FMS-155). */
function TripRiskNote({ risk }: { risk: BoardTripRisk | null | undefined }) {
  const note = tripRiskNote(risk)
  if (!note) return null
  return (
    <p
      className={cn(
        'mb-2 flex items-start gap-1.5 rounded-control px-2.5 py-1.5 text-xs [&_svg]:mt-px [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0',
        note.tone === 'info' ? 'bg-brand-soft text-ink' : 'bg-surface-muted text-ink-muted',
      )}
    >
      {note.tone === 'info' ? <FlaskConical aria-hidden="true" /> : <Activity aria-hidden="true" />}
      {note.text}
    </p>
  )
}

/** A group's heading inside the list: the suitable drivers, then the others. */
function GroupHeading({ children }: { children: ReactNode }) {
  return (
    <li role="presentation" className="px-1 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle first:pt-0">
      {children}
    </li>
  )
}

export function DriverList({
  drivers,
  selectedId,
  onSelect,
  tripRisk,
  vehicle = null,
}: {
  drivers: BoardDriver[]
  selectedId: string | null
  onSelect: (d: BoardDriver) => void
  /** The board's trip risk (FMS-155), with a chosen trip and tracking:read. */
  tripRisk?: BoardTripRisk | null
  /** The vehicle chosen for the trip: only drivers whose licence covers it are suitable. */
  vehicle?: BoardVehicle | null
}) {
  const ranked = rankDrivers(drivers, vehicle)
  const suitable = ranked.filter((r) => r.rank !== null).length
  const firstOther = ranked.findIndex((r) => r.rank === null)
  return (
    <>
      <TripRiskNote risk={tripRisk} />
      <ul className="space-y-1" aria-label="Drivers">
        {ranked.length > 0 && (
          <GroupHeading>
            {suitable === 0 ? 'No driver suitable' : `Best fit ${vehicle ? `for ${vehicle.registration_number}` : 'for this trip'}`}
            {suitable > 0 && <span className="ml-1 font-normal normal-case tracking-normal">· {suitable}</span>}
          </GroupHeading>
        )}
        {ranked.map(({ driver: d, rank, unsuitable }, i) => {
          const look = driverLook(d)
          // The distance limit (FMS-156) has its own line, with the numbers.
          const reasons = reasonsLine(d.availability, ['driver_absent', 'driver_on_leave', 'driver_sick', 'distance_limit', 'distance_limit_near'])
          const distance = distanceLine(d.distance)
          return (
            <Fragment key={d.driver_id}>
            {i === firstOther && i > 0 && <GroupHeading>Other drivers</GroupHeading>}
            <Row
              selected={d.driver_id === selectedId}
              onSelect={() => onSelect(d)}
              label={`${d.full_name}, ${look.label}${rank !== null ? `, ranked ${rank} of ${suitable}` : ''}`}
              icon={<UserRound />}
              title={d.full_name}
              rank={rank}
              subtitle={d.license_categories.length > 0 ? `Licence ${licenceText(d.license_categories)}` : 'No licence class on file'}
              badge={<StateBadge {...look} />}
              detail={
                <>
                  {unsuitable === 'licence' && vehicle && (
                    <Detail>
                      {UNSUITABLE_TEXT.licence}: {(VEHICLE_TYPE_LABELS[vehicle.vehicle_type] ?? vehicle.vehicle_type).toLowerCase()}
                    </Detail>
                  )}
                  {d.current_trip && <Detail icon={<Clock />}>On a trip until {formatTime(d.current_trip.end)}</Detail>}
                  {reasons && <Detail>{reasons}</Detail>}
                  {distance && (
                    <span
                      data-testid="distance"
                      className={cn(
                        'mt-1 flex items-center gap-1 text-xs [&_svg]:h-3.5 [&_svg]:w-3.5',
                        distance.tone === 'danger' ? 'font-medium text-danger' : distance.tone === 'warning' ? 'font-medium text-warning' : 'text-ink-muted',
                      )}
                    >
                      <Gauge aria-hidden="true" />
                      <span className="tabular">{distance.text}</span>
                    </span>
                  )}
                  {d.trip_risk && (
                    <span className="mt-1 block text-xs text-ink-muted" data-testid="trip-risk">
                      <span className="flex items-start gap-1 [&_svg]:mt-px [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0">
                        <Activity aria-hidden="true" />
                        <span>
                          <span className="font-medium text-ink">{lateLine(d.trip_risk)}</span>
                          <span className="block">{safetyLine(d.trip_risk)}</span>
                        </span>
                      </span>
                    </span>
                  )}
    </>
            }
          />
            </Fragment>
        )
      })}
    </ul>
    </>
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
