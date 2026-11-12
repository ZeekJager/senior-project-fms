import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { DataTable, EmptyState, type Column } from '@/components/shared'
import { Badge } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { INCIDENT_PAGE_SIZE, useIncidentHistory } from '@/features/incidents/api'
import { SEVERITY } from '@/pages/FleetCommandCenter/AlertsPanel'
import { toOverviewIncident, type Incident } from '@/pages/FleetCommandCenter/api'
import { IncidentDrawer } from '@/pages/FleetCommandCenter/IncidentDrawer'
import { INCIDENT_STATUS } from '@/pages/FleetCommandCenter/IncidentsPanel'
import { incidentTypeLabel } from '@/pages/FleetCommandCenter/overview'
import type { Vehicle } from '@/pages/Vehicles/types'
import { useDriverNames } from './api'
import { formatDateTime } from './format'

/**
 * The vehicle's incidents (FMS-148, BR-9), newest first: when, what, how severe, the driver involved and where it
 * stands. The same incidents are on each driver's record (S-05): both read GET /incidents, by vehicle_id here. A row
 * opens the incident in the command center's drawer, where incident:manage handles it.
 */
export function IncidentsSection({ vehicle }: { vehicle: Vehicle }) {
  const { hasPermission } = useAuth()
  const [page, setPage] = useState(1)
  const list = useIncidentHistory({ vehicleId: vehicle.id }, page)
  const names = useDriverNames(vehicle.depot_id, hasPermission('driver:read')).data
  const [openId, setOpenId] = useState<string | null>(null)
  const incidents = list.data?.incidents
  const open = incidents?.find((i) => i.id === openId) ?? null

  const columns: Column<Incident>[] = [
    {
      key: 'when',
      header: 'Date',
      width: 'w-[168px]',
      hideBelow: 'sm',
      cell: (i) => <span className="tabular text-sm text-ink">{formatDateTime(i.occurred_at)}</span>,
    },
    {
      key: 'incident',
      header: 'Incident',
      cell: (i) => (
        <div className="min-w-0">
          {/* No Date column on a phone: the date leads instead. */}
          <p className="tabular text-xs text-ink-subtle sm:hidden">{formatDateTime(i.occurred_at)}</p>
          <p className="text-sm font-medium text-ink">{incidentTypeLabel(i.incident_type)}</p>
          <p className="line-clamp-2 text-sm text-ink-muted [overflow-wrap:anywhere]">{i.description}</p>
        </div>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      width: 'w-[120px]',
      cell: (i) => (
        <Badge tone={SEVERITY[i.severity].tone} dot>
          {SEVERITY[i.severity].label}
        </Badge>
      ),
    },
    {
      key: 'driver',
      header: 'Driver',
      width: 'w-[180px]',
      hideBelow: 'md',
      cell: (i) =>
        !i.driver_id ? (
          <span className="text-sm italic text-ink-subtle">No driver recorded</span>
        ) : (
          <span className="block truncate text-sm text-ink">{names?.get(i.driver_id) ?? 'A driver from another depot'}</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-[136px]',
      hideBelow: 'sm',
      cell: (i) => <Badge tone={INCIDENT_STATUS[i.status].tone}>{INCIDENT_STATUS[i.status].label}</Badge>,
    },
  ]

  return (
    <section aria-labelledby="incidents-heading" className="space-y-4">
      <div>
        <h2 id="incidents-heading" className="text-base font-semibold text-ink">
          Incidents
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          {list.data ? (
            <>
              <span className="tabular font-medium text-ink">{list.data.meta.total_items.toLocaleString()}</span> {list.data.meta.total_items === 1 ? 'incident' : 'incidents'}, newest
              first
            </>
          ) : (
            'Accidents, breakdowns and other incidents, newest first'
          )}
        </p>
      </div>

      <DataTable
        caption={`Incidents of ${vehicle.registration_number}`}
        tableId="vehicle-incidents"
        rowHeight="stacked3"
        rowLabel={(i) => `${incidentTypeLabel(i.incident_type)}, ${formatDateTime(i.occurred_at)}`}
        onRowClick={(i) => setOpenId(i.id)}
        columns={columns}
        data={incidents}
        rowKey={(i) => i.id}
        isLoading={list.isPending}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        pagination={list.data ? { page, pageSize: INCIDENT_PAGE_SIZE, totalItems: list.data.meta.total_items, onPageChange: setPage } : undefined}
        emptyState={<EmptyState icon={<ShieldCheck />} heading="No incidents on record" description="Accidents, breakdowns and other incidents with this vehicle appear here once they are reported." />}
      />

      <IncidentDrawer
        incident={open && toOverviewIncident(open, { plate: () => vehicle.registration_number, driver: (id) => names?.get(id) ?? null })}
        depotId={open?.depot_id ?? ''}
        canManage={hasPermission('incident:manage')}
        onClose={() => setOpenId(null)}
      />
    </section>
  )
}
