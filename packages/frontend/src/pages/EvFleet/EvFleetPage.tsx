import { BatteryCharging, BatteryLow, BatteryWarning, Building2, PlugZap, Radio } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FleetMap, useNow, type FleetMapVehicle } from '@/components/FleetMap'
import { DataTable, EmptyState, MoneyDisplay, SyntheticBadge, anySynthetic, type Column } from '@/components/shared'
import { Badge, cn, FilterSelect, Skeleton, ViewTabs } from '@/components/ui'
import { StationLayer } from '@/components/StationLayer'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { useSetting } from '@/features/settings'
import { useRealtimeStatus } from '@/lib/realtime/context'
import { useLiveSnapshot } from '@/pages/FleetCommandCenter/api'
import { toMapVehicle } from '@/pages/FleetCommandCenter/liveFleet'
import { useChargingSessions, useChargingStations, useEvFleet, useLiveEv, type ChargingSession, type EvFleetVehicle, type SessionStatus } from './api'
import { LEVEL_TONE, STALE_READING_MS, STATUS_LABELS, STATUS_TONE, ago, chargeLevel, duration, fleetFigures, percent, socSpan, when } from './describe'

type SessionView = '' | 'in_progress' | 'completed' | 'failed'

/** The charge as a bar and a figure, in the level's tone: what a dispatcher reads first. */
function ChargeBar({ vehicle, line }: { vehicle: EvFleetVehicle; line: number }) {
  const level = chargeLevel(vehicle, line)
  if (!vehicle.latest) return <span className="text-sm text-ink-subtle">No reading</span>
  const soc = vehicle.latest.state_of_charge
  const bar = { critical: 'bg-danger', low: 'bg-warning', ok: 'bg-success', unknown: 'bg-line-strong' }[level]
  return (
    <span className="flex items-center gap-2.5">
      <span className="h-2 w-20 shrink-0 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
        <span className={cn('block h-full rounded-full', bar)} style={{ width: `${Math.max(2, Math.min(100, soc))}%` }} />
      </span>
      <span className={cn('tabular text-sm font-semibold', level === 'critical' ? 'text-danger' : level === 'low' ? 'text-warning' : 'text-ink')}>{percent(soc)}</span>
    </span>
  )
}

/** The EVs' figures: how many, charging now, low, without a reading. */
function Figures({ vehicles, line }: { vehicles: EvFleetVehicle[] | undefined; line: number }) {
  const f = vehicles ? fleetFigures(vehicles, line) : undefined
  const items = [
    { label: 'Electric vehicles', value: f?.total, note: 'in service in your depots', tone: undefined },
    { label: 'Charging now', value: f?.charging, note: 'sessions under way', tone: f?.charging ? 'text-brand-ink' : undefined },
    { label: 'Low charge', value: f?.low, note: `below ${line}% at the last reading`, tone: f?.low ? 'text-warning' : undefined },
    { label: 'No reading', value: f?.unknown, note: 'never reported a battery state', tone: undefined },
  ]
  return (
    <dl className="stat-strip" aria-busy={!vehicles || undefined}>
      {items.map((i) => (
        <div key={i.label} className="flex flex-col p-4 sm:p-5">
          <dt className="text-[13px] font-medium leading-tight text-ink-muted">{i.label}</dt>
          <dd className={cn('tabular mt-2 text-xl font-semibold tracking-tight text-ink sm:text-2xl', i.tone)}>{i.value?.toLocaleString() ?? <Skeleton className="h-8 w-16" />}</dd>
          <dd className="mt-1.5 text-xs text-ink-subtle">{i.note}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The sessions charging now, longest first, each with its station and how long it has charged. Live. */
function ChargingNow({ vehicles, now }: { vehicles: EvFleetVehicle[] | undefined; now: number }) {
  const charging = (vehicles ?? []).filter((v) => v.charging).sort((a, b) => Date.parse(a.charging!.started_at ?? '') - Date.parse(b.charging!.started_at ?? ''))
  return (
    <section aria-labelledby="ev-charging-now" className="rounded-card border border-line bg-surface shadow-soft">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 id="ev-charging-now" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <PlugZap className="h-4 w-4 text-brand-ink" aria-hidden="true" />
          Charging now
        </h2>
        <span className="tabular text-xs text-ink-subtle">{vehicles ? charging.length : ''}</span>
      </header>
      {!vehicles ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : charging.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-muted">No EV is charging now.</p>
      ) : (
        <ul className="divide-y divide-line" aria-live="polite">
          {charging.map((v) => (
            <li key={v.charging!.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-ink">{v.registration_number}</span>
                  <SyntheticBadge source={v.charging!.source} />
                </span>
                <span className="block truncate text-xs text-ink-muted">{v.charging!.station?.name ?? 'Station not recorded'}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="tabular block text-sm font-medium text-ink">{v.charging!.start_soc !== null ? `${percent(v.charging!.start_soc)} →` : '—'}</span>
                <span className="tabular block text-xs text-ink-subtle">{v.charging!.started_at ? duration(v.charging!.started_at, now) : ''}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * S-40 EV fleet (FMS-99): battery and charging across the electric vehicles. The list puts the lowest charge first,
 * so the EVs to charge before their next trip top it; the sessions charging now and the stations' map follow the
 * socket's EV events (polling while it is down); the session history below. Every synthetic record says so (D-06).
 * Needs ev:read (administrators, fleet managers, depot admins, fleet owners); the EVs on the map also tracking:read.
 */
export function EvFleetPage() {
  const { hasPermission } = useAuth()
  const canPickDepot = hasPermission('depot:read')
  const canTrack = hasPermission('tracking:read')
  const live = useRealtimeStatus() === 'live'
  const now = useNow(30_000)
  // The battery alert's low line (FMS-98), so the list and the alerts agree.
  const line = useSetting('ev_low_soc_pct')

  const [params, setParams] = useSearchParams()
  const depotId = params.get('depot') ?? ''
  const sessionView = (params.get('sessions') ?? '') as SessionView
  const setParam = (key: string, value: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )

  useLiveEv()
  const depots = useDepots()
  const fleet = useEvFleet(depotId)
  const stations = useChargingStations()
  const snapshot = useLiveSnapshot(depotId, canTrack)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const sessions = useChargingSessions(sessionView as SessionStatus | '', page, pageSize)

  const vehicles = fleet.data
  const synthetic = anySynthetic(vehicles?.flatMap((v) => [v.latest, v.charging].filter((r) => r !== null)) ?? [])

  const chargingAt = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of vehicles ?? []) if (v.charging?.station) m.set(v.charging.station.id, (m.get(v.charging.station.id) ?? 0) + 1)
    return m
  }, [vehicles])

  // The EVs where the tracking snapshot has them: the map shows where the low ones are, beside the stations.
  const mapVehicles = useMemo(() => {
    if (!canTrack || !vehicles || !snapshot.data) return []
    const evIds = new Set(vehicles.map((v) => v.vehicle_id))
    return snapshot.data.filter((l) => evIds.has(l.vehicle_id)).map(toMapVehicle).filter((m): m is FleetMapVehicle => m !== null)
  }, [canTrack, vehicles, snapshot.data])

  const columns: Column<EvFleetVehicle>[] = [
    {
      key: 'vehicle',
      header: 'Vehicle',
      width: 'w-[28%]',
      cell: (v) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold text-ink">{v.registration_number}</span>
            <SyntheticBadge source={v.latest?.source} />
          </span>
          <span className="block truncate text-xs text-ink-muted">
            {v.make} {v.model}
            {v.depot && <> · {v.depot.name}</>}
          </span>
        </span>
      ),
    },
    { key: 'charge', header: 'Charge', width: 'w-[22%]', cell: (v) => <ChargeBar vehicle={v} line={line} /> },
    {
      key: 'health',
      header: 'Health',
      width: 'w-[12%]',
      hideBelow: 'md',
      align: 'right',
      cell: (v) => <span className="tabular block text-right text-ink-muted">{v.latest?.battery_health != null ? percent(v.latest.battery_health) : '—'}</span>,
    },
    {
      key: 'state',
      header: 'Now',
      width: 'w-[20%]',
      cell: (v) => {
        if (v.charging)
          return (
            <Badge tone="info" icon={<BatteryCharging aria-hidden="true" />}>
              Charging
            </Badge>
          )
        const level = chargeLevel(v, line)
        if (level === 'critical' || level === 'low')
          return (
            <Badge tone={LEVEL_TONE[level]} icon={level === 'critical' ? <BatteryWarning aria-hidden="true" /> : <BatteryLow aria-hidden="true" />}>
              {level === 'critical' ? 'Critical' : 'Low'}
            </Badge>
          )
        return <span className="text-sm text-ink-subtle">{level === 'unknown' ? '—' : 'Ready'}</span>
      },
    },
    {
      key: 'reading',
      header: 'Last reading',
      width: 'w-[18%]',
      hideBelow: 'lg',
      cell: (v) =>
        v.latest ? (
          <span className={cn('block text-sm', now - Date.parse(v.latest.recorded_at) > STALE_READING_MS ? 'text-warning' : 'text-ink-muted')} title={when(v.latest.recorded_at, now)}>
            {ago(v.latest.recorded_at, now)}
          </span>
        ) : (
          <span className="text-sm text-ink-subtle">—</span>
        ),
    },
  ]

  const sessionColumns: Column<ChargingSession>[] = [
    {
      key: 'vehicle',
      header: 'Vehicle',
      width: 'w-[22%]',
      cell: (s) => (
        <span className="flex items-center gap-2">
          <span className="truncate font-semibold text-ink">{s.registration_number}</span>
          <SyntheticBadge source={s.source} />
        </span>
      ),
    },
    { key: 'station', header: 'Station', width: 'w-[22%]', hideBelow: 'md', cell: (s) => <span className="block truncate text-ink-muted">{s.station?.name ?? '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      width: 'w-[14%]',
      cell: (s) => <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABELS[s.status]}</Badge>,
    },
    { key: 'started', header: 'Started', width: 'w-[14%]', hideBelow: 'sm', cell: (s) => <span className="tabular text-sm text-ink-muted">{s.started_at ? when(s.started_at, now) : '—'}</span> },
    { key: 'charge', header: 'Charge', width: 'w-[12%]', hideBelow: 'lg', cell: (s) => <span className="tabular text-sm text-ink-muted">{socSpan(s)}</span> },
    {
      key: 'energy',
      header: 'Energy',
      width: 'w-[8%]',
      hideBelow: 'lg',
      align: 'right',
      cell: (s) => <span className="tabular block text-right text-sm text-ink-muted">{s.energy_kwh !== null ? `${s.energy_kwh.toLocaleString()} kWh` : '—'}</span>,
    },
    {
      key: 'cost',
      header: 'Cost',
      width: 'w-[8%]',
      hideBelow: 'xl',
      align: 'right',
      cell: (s) => <span className="block text-right text-sm text-ink-muted">{s.cost_cents !== null ? <MoneyDisplay amountMinorUnits={s.cost_cents} /> : '—'}</span>,
    },
  ]

  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-3 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            EV fleet
            {synthetic && <SyntheticBadge source="synthetic" />}
          </h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">Battery and charging across the electric vehicles, lowest charge first: charge these before their next trip.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className={cn('flex items-center gap-1.5 text-xs font-medium', live ? 'text-success' : 'text-ink-subtle')} title={live ? 'Charging sessions update as they happen' : 'Refreshing every 30 seconds'}>
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            {live ? 'Live' : 'Every 30 s'}
          </span>
          {canPickDepot && (depots.data?.length ?? 0) > 1 && (
            <FilterSelect label="Depot" icon={<Building2 />} value={depotId} emptyValue="" options={depotOptions} onChange={(v) => setParam('depot', v)} />
          )}
        </div>
      </header>

      <Figures vehicles={vehicles} line={line} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <DataTable
          caption="Electric vehicles, lowest charge first"
          tableId="ev-fleet"
          rowHeight="stacked"
          rowLabel={(v) => v.registration_number}
          rowClassName={(v) => (chargeLevel(v, line) === 'critical' && !v.charging ? 'bg-danger-soft/25' : undefined)}
          columns={columns}
          data={vehicles ?? []}
          rowKey={(v) => v.vehicle_id}
          isLoading={fleet.isPending}
          error={fleet.isError ? fleet.error : undefined}
          onRetry={() => void fleet.refetch()}
          emptyState={<EmptyState icon={<BatteryCharging />} heading="No electric vehicles" description="None of the vehicles in service in your depots is electric." />}
        />
        <div className="space-y-6">
          <ChargingNow vehicles={vehicles} now={now} />
          <section aria-labelledby="ev-stations" className="space-y-2">
            <h2 id="ev-stations" className="text-sm font-semibold text-ink">
              Charging stations
            </h2>
            <FleetMap
              vehicles={mapVehicles}
              label="Charging stations and electric vehicles"
              emptyMessage={canTrack ? 'No EV reporting its position' : 'Stations of the charging network'}
              className="h-[320px] shadow-soft"
            >
              <StationLayer stations={stations.data ?? []} chargingAt={chargingAt} />
            </FleetMap>
            <p className="text-xs text-ink-subtle">Filled: an EV charges there now. Dashed: out of service.</p>
          </section>
        </div>
      </div>

      <DataTable
        toolbar={
          <ViewTabs
            label="Charging sessions"
            value={sessionView || 'all'}
            options={[
              { value: 'all', label: 'All sessions' },
              { value: 'in_progress', label: 'Charging' },
              { value: 'completed', label: 'Completed' },
              { value: 'failed', label: 'Failed' },
            ]}
            onChange={(v) => {
              setPage(1)
              setParam('sessions', v === 'all' ? '' : v)
            }}
          />
        }
        caption="Charging sessions, newest first"
        tableId="ev-sessions"
        rowLabel={(s) => `${s.registration_number}, ${STATUS_LABELS[s.status]}`}
        columns={sessionColumns}
        data={sessions.data?.rows ?? []}
        rowKey={(s) => s.id}
        isLoading={sessions.isPending}
        error={sessions.isError ? sessions.error : undefined}
        onRetry={() => void sessions.refetch()}
        pagination={
          sessions.data && sessions.data.total > 0
            ? {
                page,
                pageSize,
                totalItems: sessions.data.total,
                onPageChange: setPage,
                onPageSizeChange: (size) => {
                  setPageSize(size)
                  setPage(1)
                },
              }
            : undefined
        }
        emptyState={<EmptyState icon={<PlugZap />} heading="No charging sessions" description={sessionView ? 'None with this status.' : 'No session has been recorded for your EVs yet.'} />}
      />
    </div>
  )
}
