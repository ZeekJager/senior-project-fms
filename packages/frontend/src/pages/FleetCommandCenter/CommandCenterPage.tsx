import { RefreshCw } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FleetMap, useNow, type FleetMapVehicle } from '@/components/FleetMap'
import { Card, FilterSelect, useToast, ViewTabs } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { useRealtimeEvent, useRealtimeStatus } from '@/lib/realtime/context'
import { AlertsPanel } from './AlertsPanel'
import { POLL_MS, useAlertAction, useLiveFleet, useLiveOverview, useOverview, type Names } from './api'
import { FleetList } from './FleetList'
import { IncidentDrawer } from './IncidentDrawer'
import { IncidentsPanel } from './IncidentsPanel'
import { byPlate, liveState, needsAttention, routeLabel, toMapVehicle, type LiveState } from './liveFleet'
import type { AlertCreatedEvent } from './overview'
import { StatusStrip } from './StatusStrip'
import type { VehicleLocation } from './types'

type View = 'trips' | 'attention' | 'all'
/** What the side panel shows (FMS-89): the vehicles, the active alerts, or the active incidents. */
type Panel = 'fleet' | 'alerts' | 'incidents'

const EMPTY: Record<View, { heading: string; description: string }> = {
  trips: { heading: 'No trips under way', description: 'A trip appears here as soon as its driver starts it.' },
  attention: { heading: 'Nothing needs attention', description: 'Speeding, idling, silent and offline vehicles appear here.' },
  all: { heading: 'No vehicles reporting', description: 'Vehicles appear once their tracker or driver’s phone sends a position.' },
}

/**
 * Fleet Command Center (FMS-45, S-16): every vehicle where it is now, 70% map and 30% list. One
 * snapshot over the API, then positions over the socket (vehicle.location.updated); a vehicle with no
 * ping for 2 minutes turns grey and its card says OFFLINE, without a reload. Choosing a card flies the
 * map to the vehicle and opens its popup; choosing a marker brings its card into view.
 *
 * Above the map, the overview's counters (FMS-89); beside it, the panel switches to the active alerts
 * (acknowledged and resolved here) and incidents (handled in a drawer), both kept live by the socket.
 */
export function CommandCenterPage() {
  const [params, setParams] = useSearchParams()
  const depots = useDepots()
  const depotId = params.get('depot') ?? ''
  const view: View = params.get('view') === 'attention' ? 'attention' : params.get('view') === 'all' ? 'all' : 'trips'
  const asked = params.get('panel')
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const { vehicles, snapshot, live } = useLiveFleet(depotId)
  const status = useRealtimeStatus()
  const { hasPermission } = useAuth()
  const { toast } = useToast()

  // The overview (FMS-89): counters, alerts and incidents, kept live by the socket.
  const overview = useOverview(depotId)
  const known = useRef({ vehicles, depotId })
  known.current = { vehicles, depotId }
  const names = useMemo<Names>(
    () => ({
      plate: (id) => known.current.vehicles.find((v) => v.vehicle_id === id)?.registration_number ?? null,
      driver: (id) => known.current.vehicles.find((v) => v.trip?.driver?.driver_id === id)?.trip?.driver?.full_name ?? null,
    }),
    [],
  )
  useLiveOverview(depotId, names)
  const alerts = overview.data?.alerts ?? null
  const incidents = overview.data?.incidents ?? null
  const panel: Panel = asked === 'alerts' && alerts ? 'alerts' : asked === 'incidents' && incidents ? 'incidents' : 'fleet'

  // A critical alert is said out loud as well as listed, wherever the panel is.
  useRealtimeEvent('alert.created', (payload) => {
    const e = payload as AlertCreatedEvent
    if (e?.severity !== 'critical' || (depotId && e.depot_id && e.depot_id !== depotId)) return
    toast({ title: `Critical alert: ${e.title}`, description: e.message ?? undefined, tone: 'danger' })
  })

  const alertAction = useAlertAction(depotId)
  const [alertErrors, setAlertErrors] = useState<ReadonlyMap<string, unknown>>(new Map())
  const actOnAlert = (id: string, action: 'acknowledge' | 'resolve') => {
    setAlertErrors((m) => {
      const next = new Map(m)
      next.delete(id)
      return next
    })
    alertAction.mutate({ id, action }, { onError: (err) => setAlertErrors((m) => new Map(m).set(id, err)) })
  }
  const [incidentId, setIncidentId] = useState<string | null>(null)
  const openIncident = incidents?.items.find((i) => i.id === incidentId) ?? null
  // The list's "last seen" counts up every second; the map keeps its own, slower clock.
  const now = useNow(1000)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // One map vehicle per snapshot or position object: unchanged vehicles keep theirs, so their markers do not redraw.
  const mapped = useRef(new WeakMap<VehicleLocation, FleetMapVehicle | null>())
  // A vehicle with an active breakdown incident shows as broken down (FMS-50), whatever its last ping says.
  const brokenDown = useMemo(
    () => new Set((incidents?.items ?? []).flatMap((i) => (i.incident_type === 'breakdown' && i.vehicle_id ? [i.vehicle_id] : []))),
    [incidents],
  )
  const mapVehicles = useMemo(() => {
    const out: FleetMapVehicle[] = []
    for (const v of vehicles) {
      let m = mapped.current.get(v)
      if (m === undefined) {
        m = toMapVehicle(v)
        mapped.current.set(v, m)
      }
      if (m) out.push(brokenDown.has(m.vehicleId) ? { ...m, breakdown: true } : m)
    }
    return out
  }, [vehicles, brokenDown])
  const health = useMemo(
    () => new Map((overview.data?.vehicles.health_watch ?? []).map((h) => [h.vehicle_id, { score: h.health_score, band: h.band }])),
    [overview.data],
  )

  const states = new Map<string, LiveState>(vehicles.map((v) => [v.vehicle_id, liveState(v, now)]))
  const onTrip = vehicles.filter((v) => v.trip)
  const attention = vehicles.filter((v) => needsAttention(states.get(v.vehicle_id)!))
  const inView = view === 'trips' ? onTrip : view === 'attention' ? attention : vehicles
  const needle = search.trim().toLowerCase()
  const shown = (needle ? inView.filter((v) => matches(v, needle)) : inView).slice().sort(byPlate)

  const select = useCallback((vehicleId: string) => setSelectedId(vehicleId), [])
  const onMap = useCallback((vehicleId: string) => mapVehicles.some((m) => m.vehicleId === vehicleId), [mapVehicles])
  const closed = useCallback((vehicleId: string) => setSelectedId((current) => (current === vehicleId ? null : current)), [])
  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Live map</h1>
          <p className="mt-1 text-sm text-ink-muted">Where every vehicle is now, and the trips under way.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex items-center gap-1.5 text-xs text-ink-subtle" role="status" title={live ? 'Positions arrive as vehicles report' : `Refreshes every ${POLL_MS / 1000} seconds`}>
            {live ? (
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {live ? 'Live' : status === 'down' ? `Reconnecting · refreshes every ${POLL_MS / 1000} s` : `Refreshes every ${POLL_MS / 1000} s`}
          </p>
          {(depots.data?.length ?? 0) > 1 && (
            <FilterSelect
              label="Depot"
              value={depotId}
              emptyValue=""
              onChange={(value) => {
                setSelectedId(null)
                setParam('depot', value || null)
              }}
              options={depotOptions}
            />
          )}
        </div>
      </header>

      <StatusStrip
        overview={overview.data}
        isLoading={overview.isPending}
        onShowAlerts={() => setParam('panel', 'alerts')}
        onShowIncidents={() => setParam('panel', 'incidents')}
      />

      <div className="grid gap-4 lg:h-[calc(100dvh-20rem)] lg:min-h-[560px] lg:grid-cols-[minmax(0,7fr)_minmax(360px,3fr)]">
        <FleetMap
          vehicles={mapVehicles}
          onVehicleClick={select}
          selectedVehicleId={selectedId}
          onSelectionClose={closed}
          label="Live fleet map"
          className="h-[55vh] min-h-[360px] shadow-soft lg:h-full"
        />

        <Card className="flex max-h-[70vh] min-h-0 flex-col overflow-hidden p-0 lg:max-h-none">
          {(alerts || incidents) && (
            <div className="border-b border-line px-4 pb-3 pt-4">
              <ViewTabs
                label="Panel"
                value={panel}
                onChange={(p) => setParam('panel', p === 'fleet' ? null : p)}
                options={[
                  { value: 'fleet', label: 'Fleet', count: vehicles.length, isLoading: snapshot.isPending },
                  ...(alerts ? [{ value: 'alerts' as const, label: 'Alerts', count: alerts.active, hint: 'Open and acknowledged alerts' }] : []),
                  ...(incidents ? [{ value: 'incidents' as const, label: 'Incidents', count: incidents.active, hint: 'Open incidents and those being investigated' }] : []),
                ]}
              />
            </div>
          )}
          {panel === 'alerts' && alerts ? (
            <AlertsPanel
              alerts={alerts.items}
              now={now}
              canAck={hasPermission('alert:ack')}
              canResolve={hasPermission('alert:resolve')}
              pending={alertAction.isPending && alertAction.variables ? alertAction.variables : null}
              errors={alertErrors}
              onAction={actOnAlert}
              onShowVehicle={select}
              onMap={onMap}
            />
          ) : panel === 'incidents' && incidents ? (
            <IncidentsPanel incidents={incidents.items} now={now} onOpen={setIncidentId} />
          ) : (
            <>
          <div className="px-4 pb-3 pt-4">
            <h2 className="flex items-baseline justify-between text-sm font-semibold text-ink">
              Fleet
              <span className="text-xs font-normal text-ink-subtle">
                {snapshot.isPending ? '' : `${mapVehicles.length} of ${vehicles.length} reporting`}
              </span>
            </h2>
            <div className="mt-3">
              <ViewTabs
                label="Vehicles"
                value={view}
                onChange={(v) => setParam('view', v === 'trips' ? null : v)}
                options={[
                  { value: 'trips', label: 'On trip', count: onTrip.length, isLoading: snapshot.isPending },
                  { value: 'attention', label: 'Attention', count: attention.length, isLoading: snapshot.isPending, hint: 'Speeding, idling, offline or not reported yet' },
                  { value: 'all', label: 'All', count: vehicles.length, isLoading: snapshot.isPending },
                ]}
              />
            </div>
          </div>
          {snapshot.isError && !snapshot.data ? (
            <p className="border-t border-line px-4 py-6 text-sm text-danger">
              Live positions could not be loaded. The map tries again every {POLL_MS / 1000} seconds.
            </p>
          ) : (
            <FleetList
              vehicles={shown}
              states={states}
              now={now}
              selectedId={selectedId}
              onSelect={select}
              health={health}
              isLoading={snapshot.isPending}
              search={search}
              onSearch={setSearch}
              empty={needle ? { heading: 'No match', description: 'No vehicle, driver or route here matches your search.' } : EMPTY[view]}
            />
          )}
            </>
          )}
        </Card>
      </div>

      <IncidentDrawer
        incident={openIncident}
        depotId={depotId}
        canManage={hasPermission('incident:manage')}
        onClose={() => setIncidentId(null)}
        onShowVehicle={
          openIncident?.vehicle_id && onMap(openIncident.vehicle_id)
            ? (vehicleId) => {
                setIncidentId(null)
                select(vehicleId)
              }
            : undefined
        }
      />
    </div>
  )
}

function matches(v: VehicleLocation, needle: string): boolean {
  return [v.registration_number, v.trip?.driver?.full_name, routeLabel(v.trip)].some((s) => s?.toLowerCase().includes(needle))
}
