import { ArrowRight, Route as RouteIcon } from 'lucide-react'
import { useState } from 'react'
import { DataTable, EmptyState, StatusBadge, useCursorPages, type Column } from '@/components/shared'
import { Drawer, Skeleton } from '@/components/ui'
import { TripMap, type LatLng } from '@/components/TripMap'
import { useAuth } from '@/context/AuthContext'
import type { Vehicle } from '@/pages/Vehicles/types'
import { useDriverNames, useRoute, useTrack, useVehicleTrips, type TripRecord } from './api'
import { formatDateTime, formatDay, formatDuration, formatKm, formatTime } from './format'

const startOf = (t: TripRecord) => t.actual_start ?? t.scheduled_start
const durationOf = (t: TripRecord) =>
  t.actual_start && t.actual_end ? (Date.parse(t.actual_end) - Date.parse(t.actual_start)) / 1000 : t.planned_duration_seconds

function Ends({ trip }: { trip: TripRecord }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="truncate">{trip.origin ?? 'Origin not set'}</span>
      <ArrowRight className="h-3 w-3 shrink-0 text-ink-subtle" aria-label="to" />
      <span className="truncate">{trip.destination ?? 'Destination not set'}</span>
    </span>
  )
}

/**
 * Every trip of the vehicle, newest first (FMS-136): where to, who drove, when, how far and how long. A trip opens
 * its map: the route it was planned on and, with tracking:read, the GPS track it drove.
 */
export function TripsSection({ vehicle }: { vehicle: Vehicle }) {
  const { hasPermission } = useAuth()
  const pages = useCursorPages()
  const list = useVehicleTrips(vehicle.id, pages.cursor, true)
  const drivers = useDriverNames(vehicle.depot_id, hasPermission('driver:read'))
  const [open, setOpen] = useState<TripRecord | null>(null)
  const driverName = (t: TripRecord) => (t.driver_id ? (drivers.data?.get(t.driver_id) ?? 'Driver of another depot') : 'No driver')

  const columns: Column<TripRecord>[] = [
    {
      key: 'when',
      header: 'Date',
      width: 'w-[136px]',
      cell: (t) => {
        const at = startOf(t)
        return at ? (
          <div className="tabular text-sm">
            <p className="text-ink">{formatDay(at)}</p>
            <p className="text-xs text-ink-subtle">{formatTime(at)}</p>
          </div>
        ) : (
          <span className="text-sm text-ink-subtle">Not scheduled</span>
        )
      },
    },
    {
      key: 'route',
      header: 'Route',
      cell: (t) => (
        <div className="min-w-0 text-sm">
          <p className="truncate font-medium text-ink">{t.route_name ?? 'Unnamed route'}</p>
          <p className="text-ink-muted">
            <Ends trip={t} />
          </p>
        </div>
      ),
    },
    {
      key: 'driver',
      header: 'Driver',
      width: 'w-[20%]',
      hideBelow: 'lg',
      cell: (t) => <span className="block truncate text-sm text-ink-muted">{driverName(t)}</span>,
    },
    {
      key: 'distance',
      header: 'Distance',
      width: 'w-[112px]',
      align: 'right',
      hideBelow: 'md',
      cell: (t) => {
        const km = t.actual_distance_km ?? t.planned_distance_km
        return km === null ? <span className="text-ink-subtle">—</span> : <span className="tabular text-sm text-ink-muted">{formatKm(km)}</span>
      },
    },
    {
      key: 'duration',
      header: 'Time',
      width: 'w-[104px]',
      align: 'right',
      hideBelow: 'xl',
      cell: (t) => {
        const s = durationOf(t)
        return s === null ? <span className="text-ink-subtle">—</span> : <span className="tabular text-sm text-ink-muted">{formatDuration(s)}</span>
      },
    },
    { key: 'status', header: 'Status', width: 'w-[128px]', cell: (t) => <StatusBadge status={t.status} /> },
  ]

  return (
    <section aria-labelledby="trips-heading" className="space-y-4">
      <div>
        <h2 id="trips-heading" className="text-base font-semibold text-ink">
          Trips and routes
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">Every trip, newest first. Open one to see its route and the track it drove.</p>
      </div>
      <DataTable
        caption={`Trips of ${vehicle.registration_number}`}
        tableId="vehicle-trips"
        rowHeight="stacked"
        rowLabel={(t) => `${t.route_name ?? 'Trip'}${startOf(t) ? `, ${formatDay(startOf(t)!)}` : ''}`}
        onRowClick={setOpen}
        columns={columns}
        data={list.data?.trips}
        rowKey={(t) => t.id}
        isLoading={list.isPending}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        pagination={
          list.data
            ? { kind: 'cursor', pageIndex: pages.pageIndex, pageSize: 25, hasNext: list.data.nextCursor !== null, onNext: () => pages.next(list.data!.nextCursor), onPrevious: pages.previous }
            : undefined
        }
        emptyState={<EmptyState icon={<RouteIcon />} heading="No trips yet" description="Trips this vehicle is assigned to appear here, the newest first." />}
      />
      <TripPanel vehicle={vehicle} trip={open} driver={open ? driverName(open) : ''} onClose={() => setOpen(null)} />
    </section>
  )
}

/** One trip: its facts and its map. */
function TripPanel({ vehicle, trip, driver, onClose }: { vehicle: Vehicle; trip: TripRecord | null; driver: string; onClose: () => void }) {
  const { hasPermission } = useAuth()
  const canTrack = hasPermission('tracking:read')
  const route = useRoute(trip?.route_id ?? null, trip !== null && hasPermission('route:read'))
  // A trip under way has no end yet: its track so far.
  const until = trip?.actual_end ?? (trip?.status === 'en_route' ? new Date().toISOString() : null)
  const track = useTrack(vehicle.id, trip?.actual_start ?? null, until, trip !== null && canTrack)
  const toLatLng = (c: { latitude: number; longitude: number } | null): LatLng | null => (c ? [c.latitude, c.longitude] : null)
  const duration = trip ? durationOf(trip) : null

  return (
    <Drawer
      open={trip !== null}
      onClose={onClose}
      title={trip ? (trip.route_name ?? 'Trip') : 'Trip'}
      description={trip && startOf(trip) ? `${vehicle.registration_number} · ${formatDateTime(startOf(trip)!)}` : vehicle.registration_number}
      className="sm:!max-w-[640px]"
    >
      {trip && (
        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <Fact label="Status">
              <StatusBadge status={trip.status} />
            </Fact>
            <Fact label="Driver">{driver}</Fact>
            <Fact label="Route" wide>
              <Ends trip={trip} />
            </Fact>
            <Fact label="Planned">
              {trip.scheduled_start ? formatDateTime(trip.scheduled_start) : 'Not scheduled'}
              {trip.planned_distance_km !== null && <span className="block text-ink-muted">{formatKm(trip.planned_distance_km)}{trip.planned_duration_seconds ? ` · ${formatDuration(trip.planned_duration_seconds)}` : ''}</span>}
            </Fact>
            <Fact label="Driven">
              {trip.actual_start ? `${formatDateTime(trip.actual_start)}${trip.actual_end ? ` – ${formatTime(trip.actual_end)}` : ', under way'}` : 'Not started'}
              {(trip.actual_distance_km !== null || (trip.actual_end && duration !== null)) && (
                <span className="block text-ink-muted">
                  {[trip.actual_distance_km !== null ? formatKm(trip.actual_distance_km) : null, trip.actual_end && duration !== null ? formatDuration(duration) : null].filter(Boolean).join(' · ')}
                </span>
              )}
            </Fact>
          </dl>

          {route.isPending && route.fetchStatus !== 'idle' ? (
            <Skeleton className="h-80 w-full rounded-card" />
          ) : (
            <div className="space-y-2">
              <TripMap
                label={`Map of ${trip.route_name ?? 'the trip'}`}
                planned={{ origin: toLatLng(route.data?.origin ?? null), destination: toLatLng(route.data?.destination ?? null) }}
                track={(track.data ?? []).map((p): LatLng => [p.lat, p.lng])}
                className="h-80"
              />
              <p className="text-xs text-ink-subtle">
                {!canTrack
                  ? 'The GPS track needs tracking access; the planned route is shown.'
                  : track.isPending && track.fetchStatus !== 'idle'
                    ? 'Loading the GPS track…'
                    : !trip.actual_start
                      ? 'No GPS track: the trip has not started.'
                      : (track.data ?? []).length === 0
                        ? 'No GPS points were recorded on this trip.'
                        : `${(track.data ?? []).length.toLocaleString()} GPS points, ${formatTime(track.data![0].recorded_at)} to ${formatTime(track.data!.at(-1)!.recorded_at)}.`}
              </p>
            </div>
          )}
        </div>
      )}
    </Drawer>
  )
}

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="mt-1 text-ink">{children}</dd>
    </div>
  )
}
