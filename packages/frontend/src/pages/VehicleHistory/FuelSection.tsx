import { Fuel, Gauge } from 'lucide-react'
import { useState } from 'react'
import { DataTable, EmptyState, FuelDisplay, MoneyDisplay, type Column } from '@/components/shared'
import { Badge } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import type { Vehicle } from '@/pages/Vehicles/types'
import { useOdometerReadings, useVehicleFuel, type FuelLog, type MeterReading } from './api'
import { formatDateTime, formatKm } from './format'

const FUEL_SOURCE: Record<FuelLog['source'], string> = { pump: 'Pump', fuel_card: 'Fuel card', manual: 'Entered by hand' }
const READING_SOURCE: Record<MeterReading['source'], string> = {
  fuel_log: 'Fuel log',
  maintenance: 'Repair',
  telematics: 'Telematics',
  gps_derived: 'GPS',
  manual: 'Entered by hand',
}

/**
 * Fuel and odometer (FMS-136): every fill-up with litres, cost and the odometer then (fuel:read), and the
 * odometer's readings over time with where each came from (vehicle:read). An electric vehicle has no fill-ups.
 */
export function FuelSection({ vehicle }: { vehicle: Vehicle }) {
  const { hasPermission } = useAuth()
  const canFuel = hasPermission('fuel:read')
  return (
    <div className="space-y-10">
      {canFuel && <FillUps vehicle={vehicle} />}
      <Readings vehicle={vehicle} />
    </div>
  )
}

function FillUps({ vehicle }: { vehicle: Vehicle }) {
  const [page, setPage] = useState(1)
  const list = useVehicleFuel(vehicle.id, page, true)
  const electric = vehicle.fuel_type === 'electric'

  const columns: Column<FuelLog>[] = [
    { key: 'when', header: 'Date', width: 'w-[176px]', cell: (f) => <span className="tabular text-sm text-ink">{formatDateTime(f.recorded_at)}</span> },
    { key: 'litres', header: 'Litres', width: 'w-[112px]', align: 'right', cell: (f) => <FuelDisplay amountMinorUnits={f.quantity_ml} className="text-sm" /> },
    { key: 'cost', header: 'Cost', width: 'w-[136px]', align: 'right', cell: (f) => <MoneyDisplay amountMinorUnits={f.total_cost_cents} className="font-medium" /> },
    {
      key: 'price',
      header: 'Per litre',
      width: 'w-[112px]',
      align: 'right',
      hideBelow: 'xl',
      cell: (f) => (f.unit_price_cents === null ? <span className="text-ink-subtle">—</span> : <MoneyDisplay amountMinorUnits={f.unit_price_cents} className="text-sm text-ink-muted" />),
    },
    {
      key: 'odometer',
      header: 'Odometer',
      width: 'w-[120px]',
      align: 'right',
      hideBelow: 'md',
      cell: (f) => (f.odometer_km === null ? <span className="text-ink-subtle">—</span> : <span className="tabular text-sm text-ink-muted">{formatKm(f.odometer_km)}</span>),
    },
    {
      key: 'station',
      header: 'Station',
      hideBelow: 'lg',
      cell: (f) => (
        <div className="min-w-0 text-sm">
          <p className="truncate text-ink-muted">{f.station_name ?? '—'}</p>
          <p className="text-xs text-ink-subtle">{FUEL_SOURCE[f.source]}</p>
        </div>
      ),
    },
  ]

  return (
    <section aria-labelledby="fuel-heading" className="space-y-4">
      <div>
        <h2 id="fuel-heading" className="text-base font-semibold text-ink">
          Fill-ups
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">Every fill-up, newest first, with the odometer when it was logged.</p>
      </div>
      <DataTable
        caption={`Fill-ups of ${vehicle.registration_number}`}
        tableId="vehicle-fuel"
        rowHeight="stacked"
        columns={columns}
        data={list.data?.logs}
        rowKey={(f) => f.id}
        isLoading={list.isPending}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        pagination={list.data ? { page, pageSize: 25, totalItems: list.data.meta.total_items, onPageChange: setPage } : undefined}
        emptyState={
          <EmptyState
            icon={<Fuel />}
            heading={electric ? 'An electric vehicle' : 'No fill-ups yet'}
            description={electric ? 'It charges instead of filling up, so it has no fuel logs.' : 'Fill-ups logged by its drivers or the fuel clerk appear here.'}
          />
        }
      />
    </section>
  )
}

function Readings({ vehicle }: { vehicle: Vehicle }) {
  const [page, setPage] = useState(1)
  const list = useOdometerReadings(vehicle.id, page)

  const columns: Column<MeterReading>[] = [
    { key: 'when', header: 'Date', width: 'w-[176px]', cell: (r) => <span className="tabular text-sm text-ink">{formatDateTime(r.recorded_at)}</span> },
    {
      key: 'value',
      header: 'Odometer',
      width: 'w-[136px]',
      align: 'right',
      cell: (r) => <span className={r.suspect ? 'tabular text-sm text-ink-subtle line-through' : 'tabular text-sm font-medium text-ink'}>{formatKm(r.value)}</span>,
    },
    {
      key: 'source',
      header: 'From',
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          {READING_SOURCE[r.source]}
          {r.suspect && (
            <span title="Lower than an earlier trusted reading: kept, but the vehicle's odometer did not follow it">
              <Badge tone="warning">Suspect</Badge>
            </span>
          )}
        </span>
      ),
    },
  ]

  return (
    <section aria-labelledby="odometer-heading" className="space-y-4">
      <div>
        <h2 id="odometer-heading" className="text-base font-semibold text-ink">
          Odometer readings
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Now <span className="tabular font-medium text-ink">{formatKm(vehicle.odometer_km)}</span>. Each reading, newest first, and where it came from.
        </p>
      </div>
      <DataTable
        caption={`Odometer readings of ${vehicle.registration_number}`}
        tableId="vehicle-odometer"
        columns={columns}
        data={list.data?.readings}
        rowKey={(r) => r.id}
        isLoading={list.isPending}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        pagination={list.data ? { page, pageSize: 25, totalItems: list.data.meta.total_items, onPageChange: setPage } : undefined}
        emptyState={<EmptyState icon={<Gauge />} heading="No readings yet" description="Fill-ups, repairs and the vehicle's own device record its odometer here." />}
      />
    </section>
  )
}
