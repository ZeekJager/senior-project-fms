import { ChevronRight, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, ErrorState } from '@/components/shared'
import { Badge, Button, Drawer, Skeleton } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { INCIDENT_PAGE_SIZE, useIncidentHistory, usePlates } from '@/features/incidents/api'
import { SEVERITY } from '@/pages/FleetCommandCenter/AlertsPanel'
import { toOverviewIncident } from '@/pages/FleetCommandCenter/api'
import { IncidentDrawer } from '@/pages/FleetCommandCenter/IncidentDrawer'
import { INCIDENT_STATUS } from '@/pages/FleetCommandCenter/IncidentsPanel'
import { incidentTypeLabel } from '@/pages/FleetCommandCenter/overview'
import { formatDateTime } from '@/pages/VehicleHistory/format'
import type { Driver } from './types'

/**
 * A driver's incidents (FMS-148, BR-9), newest first: the ones they were involved in, read from GET /incidents
 * by driver_id, so the vehicle's record shows the same ones. Each names its vehicle, linking to the vehicle's own
 * incidents, or says none was recorded. One opens in place of the list, in the command center's drawer.
 */
export function DriverIncidentsDrawer({ driver, onClose }: { driver: Driver | null; onClose: () => void }) {
  if (!driver) return null
  // Keyed: another driver starts again on page 1, with nothing open.
  return <IncidentsOf key={driver.id} driver={driver} onClose={onClose} />
}

function IncidentsOf({ driver, onClose }: { driver: Driver; onClose: () => void }) {
  const { hasPermission } = useAuth()
  const [page, setPage] = useState(1)
  const list = useIncidentHistory({ driverId: driver.id }, page)
  const incidents = list.data?.incidents ?? []
  const plates = usePlates(incidents.flatMap((i) => (i.vehicle_id ? [i.vehicle_id] : [])), true)
  const [openId, setOpenId] = useState<string | null>(null)
  const open = incidents.find((i) => i.id === openId) ?? null
  const total = list.data?.meta.total_items ?? 0
  const pages = Math.max(1, Math.ceil(total / INCIDENT_PAGE_SIZE))

  if (open) {
    return (
      <IncidentDrawer
        incident={toOverviewIncident(open, { plate: (id) => plates.get(id) ?? null, driver: () => driver.full_name })}
        depotId={open.depot_id ?? ''}
        canManage={hasPermission('incident:manage')}
        onClose={() => setOpenId(null)}
      />
    )
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Incidents: ${driver.full_name}`}
      description={list.data ? `${total.toLocaleString()} on record, newest first` : 'Every incident this driver was involved in'}
      footer={
        pages > 1 ? (
          <div className="flex w-full items-center justify-between gap-3">
            <p className="tabular text-xs text-ink-subtle">
              Page {page} of {pages}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                Newer
              </Button>
              <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Older
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      {list.isError && !list.data ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : incidents.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} heading="No incidents on record" description="Accidents, breakdowns and other incidents this driver is involved in appear here once they are reported." />
      ) : (
        <ul className="space-y-2" aria-label={`Incidents of ${driver.full_name}`}>
          {incidents.map((i) => (
            <li key={i.id} className="rounded-control border border-line bg-surface transition-colors hover:border-line-strong">
              <button type="button" onClick={() => setOpenId(i.id)} className="focus-ring flex w-full items-start gap-3 rounded-control px-3.5 pb-1 pt-3 text-left">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={SEVERITY[i.severity].tone} dot>
                      {SEVERITY[i.severity].label}
                    </Badge>
                    <Badge tone={INCIDENT_STATUS[i.status].tone}>{INCIDENT_STATUS[i.status].label}</Badge>
                  </span>
                  <span className="mt-1.5 block text-sm font-medium text-ink">{incidentTypeLabel(i.incident_type)}</span>
                  <span className="line-clamp-2 block text-sm text-ink-muted [overflow-wrap:anywhere]">{i.description}</span>
                </span>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
              </button>
              <p className="flex flex-wrap items-center gap-x-2 px-3.5 pb-3 text-xs text-ink-subtle">
                <span className="tabular">{formatDateTime(i.occurred_at)}</span>
                <span aria-hidden="true">·</span>
                {!i.vehicle_id ? (
                  <span className="italic">No vehicle recorded</span>
                ) : plates.has(i.vehicle_id) ? (
                  <Link to={`/vehicles/${i.vehicle_id}?section=incidents`} className="plate focus-ring rounded-control font-medium text-brand underline-offset-2 hover:underline">
                    {plates.get(i.vehicle_id)}
                  </Link>
                ) : (
                  <span>A vehicle outside your depots</span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  )
}
