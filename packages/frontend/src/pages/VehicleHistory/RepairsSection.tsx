import { Eye, Plus, Wrench } from 'lucide-react'
import { useState } from 'react'
import { DataTable, EmptyState, MoneyDisplay, StatusBadge, type Column } from '@/components/shared'
import { Button } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { formatDate } from '@/features/documents/expiry'
import { LogRepairDrawer } from '@/pages/Maintenance'
import { TYPE_LABELS, useRecords, type MaintenanceRecord } from '@/pages/Maintenance/api'
import { RecordDrawer } from '@/pages/Maintenance/RecordDrawer'
import type { Vehicle } from '@/pages/Vehicles/types'
import { formatKm } from './format'

/** When a record happened: completed, else started, else scheduled, else logged. */
const whenOf = (r: MaintenanceRecord) => r.completed_at ?? r.started_at ?? r.scheduled_at ?? r.created_at

/**
 * Every repair, service and inspection of the vehicle, newest first (FMS-136): what was done, the parts and
 * their cost, the odometer then, and who did it. A row opens the full record; logging new work opens the job card.
 */
export function RepairsSection({ vehicle }: { vehicle: Vehicle }) {
  const { hasPermission } = useAuth()
  const canWrite = hasPermission('maintenance:write')
  const [page, setPage] = useState(1)
  const list = useRecords({ view: 'all', vehicleId: vehicle.id, page, byWorkDate: true })
  const [viewing, setViewing] = useState<MaintenanceRecord | null>(null)
  const [logging, setLogging] = useState(false)

  const columns: Column<MaintenanceRecord>[] = [
    {
      key: 'when',
      header: 'Date',
      width: 'w-[120px]',
      hideBelow: 'sm',
      cell: (r) => <span className="tabular text-sm text-ink">{formatDate(whenOf(r).slice(0, 10))}</span>,
    },
    {
      key: 'work',
      header: 'Work',
      cell: (r) => (
        <div className="min-w-0">
          {/* No Date column on a phone: the date leads the work instead. */}
          <p className="tabular text-xs text-ink-subtle sm:hidden">{formatDate(whenOf(r).slice(0, 10))}</p>
          <p className="text-sm font-medium text-ink">{TYPE_LABELS[r.maintenance_type]}</p>
          <p className="line-clamp-2 text-sm text-ink-muted">{r.description ?? 'No description'}</p>
          {r.parts.length > 0 && (
            <p className="mt-1 truncate text-xs text-ink-subtle" title={r.parts.map((p) => `${p.name} × ${p.quantity}`).join(', ')}>
              {r.parts.map((p) => `${p.name} × ${p.quantity}`).join(', ')}
            </p>
          )}
          {/* No Status column on a phone: an unfinished record says so here. */}
          {r.status !== 'completed' && (
            <span className="mt-1 inline-block md:hidden">
              <StatusBadge status={r.status} />
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'odometer',
      header: 'Odometer',
      width: 'w-[120px]',
      align: 'right',
      hideBelow: 'lg',
      cell: (r) => (r.odometer_km === null ? <span className="text-ink-subtle">—</span> : <span className="tabular text-sm text-ink-muted">{formatKm(r.odometer_km)}</span>),
    },
    {
      key: 'labour',
      header: 'Labour',
      width: 'w-[88px]',
      align: 'right',
      hideBelow: 'xl',
      cell: (r) => (r.labour_hours === null ? <span className="text-ink-subtle">—</span> : <span className="tabular text-sm text-ink-muted">{r.labour_hours} h</span>),
    },
    { key: 'status', header: 'Status', width: 'w-[128px]', hideBelow: 'md', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'cost',
      header: 'Cost',
      width: 'w-[136px]',
      align: 'right',
      cell: (r) => <MoneyDisplay amountMinorUnits={r.total_cost_cents} className="font-medium" />,
    },
    {
      key: 'open',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[56px]',
      align: 'right',
      cell: (r) => (
        <Button size="sm" variant="ghost" onClick={() => setViewing(r)} aria-label={`View ${TYPE_LABELS[r.maintenance_type]} of ${formatDate(whenOf(r).slice(0, 10))}`}>
          <Eye className="h-4 w-4" aria-hidden="true" />
        </Button>
      ),
      skeleton: <span />,
    },
  ]

  return (
    <section aria-labelledby="repairs-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="repairs-heading" className="text-base font-semibold text-ink">
            Repair and service history
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {list.data ? (
              <>
                <span className="tabular font-medium text-ink">{list.data.meta.total_items.toLocaleString()}</span> {list.data.meta.total_items === 1 ? 'record' : 'records'}, newest first
              </>
            ) : (
              'Every repair, service and inspection, newest first'
            )}
          </p>
        </div>
        {canWrite && vehicle.status !== 'retired' && (
          <Button variant="secondary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setLogging(true)}>
            Log a repair
          </Button>
        )}
      </div>

      <DataTable
        caption={`Repair history of ${vehicle.registration_number}`}
        tableId="vehicle-repairs"
        rowHeight="stacked3"
        rowLabel={(r) => `${TYPE_LABELS[r.maintenance_type]}, ${formatDate(whenOf(r).slice(0, 10))}`}
        onRowClick={setViewing}
        columns={columns}
        data={list.data?.records}
        rowKey={(r) => r.id}
        isLoading={list.isPending}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        pagination={list.data ? { page, pageSize: 25, totalItems: list.data.meta.total_items, onPageChange: setPage } : undefined}
        emptyState={<EmptyState icon={<Wrench />} heading="No repairs yet" description="Repairs, services and inspections of this vehicle appear here once they are logged." />}
      />

      <RecordDrawer record={viewing} onClose={() => setViewing(null)} canWrite={false} onCorrect={() => {}} />
      {/* Mounted only while open: the job card loads the flagged vehicles and parts as it opens. */}
      {logging && (
        <LogRepairDrawer
          open
          onClose={() => setLogging(false)}
          canInventory={hasPermission('inventory:read')}
          preset={{ vehicle: { id: vehicle.id, registration_number: vehicle.registration_number }, type: 'corrective', description: '' }}
        />
      )}
    </section>
  )
}
