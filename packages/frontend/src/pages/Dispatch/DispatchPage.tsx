import { MousePointerClick, Plus, RefreshCw, Route as RouteIcon, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState } from '@/components/shared'
import { Button, Card, FilterSelect, useToast, ViewTabs } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { ApiError } from '@/lib/api/errors'
import { useRealtimeStatus } from '@/lib/realtime/context'
import { POLL_MS, useAssignTrip, useDispatchBoard, useDispatchTrips, useUnderWayTrips } from './api'
import { AssignmentPanel, UnderWayPanel } from './AssignmentPanel'
import { CandidatesSkeleton, DriverList, VehicleList } from './Candidates'
import { formatTime, tripTitle } from './format'
import { NewTripDrawer } from './NewTripDrawer'
import { TripList } from './TripList'
import { TripTimesDrawer } from './TripTimesDrawer'
import type { AssignmentWarning, Trip } from './types'

type View = 'unassigned' | 'assigned' | 'under-way'
const VIEWS: readonly View[] = ['unassigned', 'assigned', 'under-way']

const EMPTY: Record<View, { heading: string; description: string }> = {
  unassigned: { heading: 'Every trip is assigned', description: 'New scheduled trips from today on appear here.' },
  assigned: { heading: 'No assigned trips', description: 'Trips you assign appear here until they start.' },
  'under-way': { heading: 'No trips under way', description: 'Trips appear here once their driver starts them. Their end can still move.' },
}

/**
 * Dispatcher trip console (FMS-33, S-07): the depot's trips on the left, its
 * drivers and vehicles on the right with what they are doing now and whether
 * they are free for the chosen trip, and one panel to assign. Refreshes as
 * trips and vehicles change (Socket.IO, FMS-43), and every 30 seconds anyway.
 */
export function DispatchPage() {
  const [params, setParams] = useSearchParams()
  const depots = useDepots()
  const depotId = params.get('depot') ?? depots.data?.[0]?.id ?? ''
  const view: View = VIEWS.find((v) => v === params.get('view')) ?? 'unassigned'
  const { hasPermission } = useAuth()
  const canWrite = hasPermission('trip:write')
  const [newTripOpen, setNewTripOpen] = useState(false)
  const [timesOpen, setTimesOpen] = useState(false)
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  // trip.updated and vehicle.status.changed refresh the board at once (FMS-43); polling stays the fallback.
  const live = useRealtimeStatus() === 'live'
  const trips = useDispatchTrips(depotId)
  const underWay = useUnderWayTrips(depotId)
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null)
  const allTrips = trips.data ?? []
  const underWayTrips = underWay.data ?? []
  const listed = view === 'under-way' ? underWay : trips
  const shown = view === 'under-way' ? underWayTrips : allTrips.filter((t) => (view === 'assigned' ? t.status === 'assigned' : t.status === 'scheduled'))
  const trip = allTrips.find((t) => t.id === selectedTripId) ?? underWayTrips.find((t) => t.id === selectedTripId) ?? null
  // A trip under way keeps its driver and vehicle: the lists show who is where, nothing to choose.
  const assignable = trip !== null && trip.status !== 'en_route'
  const board = useDispatchBoard(depotId, trip)

  const [search, setSearch] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const [driverId, setDriverId] = useState<string | null>(null)
  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<AssignmentWarning[] | null>(null)
  const assign = useAssignTrip()
  const { toast } = useToast()

  // A new trip starts from its current assignment, with no answer shown. On a
  // narrow screen the panel is below the trips: bring it into view.
  useEffect(() => {
    setDriverId(trip?.driver_id ?? null)
    setVehicleId(trip?.vehicle_id ?? null)
    setWarnings(null)
    assign.reset()
    if (selectedTripId && !window.matchMedia?.('(min-width: 1024px)').matches) panelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [selectedTripId])

  const drivers = board.data?.drivers ?? []
  const vehicles = board.data?.vehicles ?? []
  const needle = search.trim().toLowerCase()
  const shownDrivers = needle ? drivers.filter((d) => d.full_name.toLowerCase().includes(needle)) : drivers
  const shownVehicles = needle
    ? vehicles.filter((v) => [v.registration_number, v.make, v.model, v.vehicle_type].some((s) => s.toLowerCase().includes(needle)))
    : vehicles
  const driver = drivers.find((d) => d.driver_id === driverId) ?? null
  const vehicle = vehicles.find((v) => v.vehicle_id === vehicleId) ?? null
  const names = useMemo(() => new Map(drivers.map((d) => [d.driver_id, d.full_name])), [drivers])
  const plates = useMemo(() => new Map(vehicles.map((v) => [v.vehicle_id, v.registration_number])), [vehicles])

  function choose(kind: 'driver' | 'vehicle', id: string) {
    if (kind === 'driver') setDriverId(id)
    else setVehicleId(id)
    setWarnings(null)
    assign.reset()
  }

  async function submit() {
    if (!trip || !driverId || !vehicleId) return
    try {
      const result = await assign.mutateAsync({ trip, driverId, vehicleId })
      setWarnings(result.warnings)
      toast({ title: `${tripTitle(result.trip)} assigned`, description: `${driver?.full_name ?? 'Driver'} with ${vehicle?.registration_number ?? 'the vehicle'}.` })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT_CONCURRENT_MODIFICATION') void trips.refetch()
    }
  }

  const unassignedCount = allTrips.filter((t) => t.status === 'scheduled').length
  const assignedCount = allTrips.filter((t) => t.status === 'assigned').length
  const updatedAt = Math.max(trips.dataUpdatedAt, board.dataUpdatedAt)
  const titleOf = (id: string) => {
    const t = allTrips.find((x) => x.id === id) ?? underWayTrips.find((x) => x.id === id)
    return t ? tripTitle(t) : undefined
  }
  const depot = depots.data?.find((d) => d.id === depotId)

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Dispatch</h1>
          <p className="mt-1 text-sm text-ink-muted">Staff today’s and upcoming trips with drivers and vehicles who are free.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {updatedAt > 0 && (
            <p
              className="flex items-center gap-1.5 text-xs text-ink-subtle"
              title={live ? 'Changes arrive as they happen' : `Refreshes every ${POLL_MS / 1000} seconds`}
            >
              {live ? (
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                </span>
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {live ? 'Live · ' : ''}Updated {formatTime(new Date(updatedAt).toISOString())}
            </p>
          )}
          {(depots.data?.length ?? 0) > 1 && (
            <FilterSelect
              label="Depot"
              value={depotId}
              onChange={(value) => {
                setSelectedTripId(null)
                setParam('depot', value)
              }}
              options={(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
            />
          )}
          {canWrite && depot && (
            <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setNewTripOpen(true)}>
              New trip
            </Button>
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-labelledby="dispatch-trips" className="min-w-0 space-y-3">
          <h2 id="dispatch-trips" className="sr-only">
            Trips
          </h2>
          <ViewTabs
            label="Trips"
            value={view}
            onChange={(v) => setParam('view', v === 'unassigned' ? null : v)}
            options={[
              { value: 'unassigned', label: 'Unassigned', count: unassignedCount, isLoading: trips.isPending },
              { value: 'assigned', label: 'Assigned', count: assignedCount, isLoading: trips.isPending },
              { value: 'under-way', label: 'Under way', count: underWayTrips.length, isLoading: underWay.isPending, hint: 'Started, whenever that was' },
            ]}
          />
          {listed.isError ? (
            <Card>
              <EmptyState icon={<RouteIcon />} heading="Trips could not be loaded" description="Check your connection; the console tries again every 30 seconds." />
            </Card>
          ) : !listed.isPending && shown.length === 0 ? (
            <Card>
              <EmptyState icon={<RouteIcon />} heading={EMPTY[view].heading} description={EMPTY[view].description} />
            </Card>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto overscroll-contain rounded-control p-0.5 lg:max-h-[calc(100vh-16rem)]">
            <TripList
              trips={shown}
              isLoading={listed.isPending}
              selectedId={selectedTripId}
              onSelect={(t: Trip) => setSelectedTripId(t.id)}
              driverName={(id) => names.get(id)}
              plate={(id) => plates.get(id)}
            />
            </div>
          )}
        </section>

        <section aria-label="Drivers and vehicles" className="min-w-0 space-y-4">
          <div ref={panelRef} className="scroll-mt-6">
          {trip && !assignable ? (
            <UnderWayPanel
              trip={trip}
              driverName={trip.driver_id ? names.get(trip.driver_id) : undefined}
              plate={trip.vehicle_id ? plates.get(trip.vehicle_id) : undefined}
              onChangeTimes={canWrite ? () => setTimesOpen(true) : undefined}
            />
          ) : trip ? (
            <AssignmentPanel
              trip={trip}
              driver={driver}
              vehicle={vehicle}
              busy={assign.isPending}
              error={assign.error}
              warnings={warnings}
              onAssign={submit}
              onChangeTimes={canWrite ? () => setTimesOpen(true) : undefined}
            />
          ) : (
            <Card>
              <EmptyState icon={<MousePointerClick />} heading="Choose a trip" description="Pick a trip on the left to see who is free for it, then choose a driver and a vehicle." />
            </Card>
          )}
          </div>

          <Card className="p-4">
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
              <input
                type="search"
                aria-label="Find a driver or vehicle"
                placeholder="Find a driver, plate or model"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="focus-ring h-9 w-full rounded-control border border-line-strong bg-surface-muted pl-10 pr-3 text-sm text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-ink-subtle hover:border-ink-subtle/50 focus:border-brand coarse:h-11"
              />
            </div>
            <div className="grid gap-5 xl:grid-cols-2">
              <div className="min-w-0">
                <h2 className="mb-2 flex items-baseline justify-between px-1 text-sm font-semibold text-ink">
                  Drivers <span className="text-xs font-normal text-ink-subtle">{drivers.filter((d) => d.state === 'idle').length} available</span>
                </h2>
                <div className="max-h-[420px] overflow-y-auto overscroll-contain pr-1">
                  {board.isPending ? <CandidatesSkeleton /> : <DriverList drivers={shownDrivers} selectedId={assignable ? driverId : null} onSelect={(d) => assignable && choose('driver', d.driver_id)} />}
                </div>
              </div>
              <div className="min-w-0">
                <h2 className="mb-2 flex items-baseline justify-between px-1 text-sm font-semibold text-ink">
                  Vehicles <span className="text-xs font-normal text-ink-subtle">{vehicles.filter((v) => v.state === 'idle').length} available</span>
                </h2>
                <div className="max-h-[420px] overflow-y-auto overscroll-contain pr-1">
                  {board.isPending ? <CandidatesSkeleton /> : <VehicleList vehicles={shownVehicles} selectedId={assignable ? vehicleId : null} onSelect={(v) => assignable && choose('vehicle', v.vehicle_id)} />}
                </div>
              </div>
            </div>
            {board.isError && <p className="mt-3 px-1 text-sm text-danger">Drivers and vehicles could not be loaded. The console tries again every 30 seconds.</p>}
          </Card>
        </section>
      </div>

      {canWrite && depot && (
        <NewTripDrawer
          open={newTripOpen}
          onClose={() => setNewTripOpen(false)}
          depot={depot}
          onCreated={(created) => {
            setParam('view', null)
            setSelectedTripId(created.id)
          }}
        />
      )}
      {canWrite && <TripTimesDrawer open={timesOpen} onClose={() => setTimesOpen(false)} trip={trip} titleOf={titleOf} />}
    </div>
  )
}
