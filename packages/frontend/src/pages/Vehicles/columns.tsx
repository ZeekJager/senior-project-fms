import { AlertTriangle, ArrowRight, Bike, Bus, Car, CarFront, FileText, MapPin, Paperclip, Pencil, Plus, Truck, Archive, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { StatusBadge, type Column } from '@/components/shared'
import { Badge, cn, IconButton, Skeleton } from '@/components/ui'
import type { DocumentHealth } from './documents'
import { VEHICLE_TYPE_LABELS, type Depot, type Vehicle, type VehicleType } from './types'

const TYPE_ICONS: Record<VehicleType, LucideIcon> = {
  car: Car,
  suv: CarFront,
  van: Truck,
  truck: Truck,
  bus: Bus,
  motorcycle: Bike,
  other: Car,
}

export interface ColumnContext {
  depots: Map<string, Depot>
  documents: { health: Map<string, DocumentHealth>; isLoading: boolean; canRead: boolean; canWrite: boolean }
  canWrite: boolean
  canDelete: boolean
  onEdit: (vehicle: Vehicle) => void
  onDecommission: (vehicle: Vehicle) => void
  onOpenDocuments: (vehicle: Vehicle) => void
  onAddDocument: (vehicle: Vehicle) => void
}

/**
 * The vehicle table's columns. Widths keep 200 rows inside a 1440px screen
 * without sideways scrolling; narrower screens drop the less important
 * columns (the plate cell then carries the status).
 */
export function vehicleColumns(ctx: ColumnContext): Column<Vehicle>[] {
  const columns: Column<Vehicle>[] = [
    {
      key: 'vehicle',
      header: 'Vehicle',
      sortKey: 'registration_number',
      cell: (v) => (
        <div className="flex min-w-0 items-center gap-3">
          <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-ink-muted ring-1 ring-inset ring-line sm:flex">
            {(() => {
              const Icon = TYPE_ICONS[v.vehicle_type]
              return <Icon className="h-4 w-4" aria-hidden="true" />
            })()}
          </div>
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-semibold tracking-wide text-ink">
              {v.registration_number}
              {v.maintenance_flag && (
                <span title="Flagged for maintenance" className="text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">Flagged for maintenance</span>
                </span>
              )}
            </p>
            <p className="truncate text-xs text-ink-subtle">
              {v.make} {v.model}
              {v.year ? ` · ${v.year}` : ''}
            </p>
          </div>
          <span className="ml-auto sm:hidden">
            <StatusBadge status={v.status} />
          </span>
        </div>
      ),
      skeleton: (
        <div className="flex items-center gap-3">
          <Skeleton className="hidden h-9 w-9 rounded-xl sm:block" />
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      width: 'w-[9%]',
      hideBelow: 'xl',
      cell: (v) => <span className="text-ink-muted">{VEHICLE_TYPE_LABELS[v.vehicle_type]}</span>,
    },
    {
      key: 'depot',
      header: 'Depot',
      width: 'w-[15%]',
      hideBelow: 'xl',
      cell: (v) => (
        <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
          <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />
          <span className="truncate" title={ctx.depots.get(v.depot_id)?.name}>{ctx.depots.get(v.depot_id)?.name ?? '—'}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-[148px]',
      hideBelow: 'sm',
      cell: (v) => <StatusBadge status={v.status} />,
      skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
    },
    {
      key: 'trip',
      header: 'Current trip',
      width: 'w-[18%]',
      hideBelow: 'lg',
      cell: (v) =>
        v.current_trip ? (
          <Link
            to={`/dispatch?trip=${v.current_trip.id}`}
            className="focus-ring group/trip -mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-brand-soft"
          >
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                v.current_trip.status === 'en_route' ? 'animate-pulse bg-amber-500' : 'bg-blue-500',
              )}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink group-hover/trip:text-brand-ink">
                {v.current_trip.origin ?? 'Origin'} <ArrowRight className="inline h-3 w-3" aria-label="to" /> {v.current_trip.destination ?? 'Destination'}
              </span>
              <span className="block text-xs text-ink-subtle">{v.current_trip.status === 'en_route' ? 'En route' : 'Assigned'}</span>
            </span>
          </Link>
        ) : (
          <span className="text-ink-subtle">No active trip</span>
        ),
    },
  ]

  if (ctx.documents.canRead) {
    columns.push({
      key: 'documents',
      header: 'Documents',
      width: 'w-[160px]',
      hideBelow: 'md',
      cell: (v) => <DocumentsCell vehicle={v} ctx={ctx} />,
      skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
    })
  }

  if (ctx.canWrite || ctx.canDelete) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[104px]',
      align: 'right',
      cell: (v) => (
        <div className="flex justify-end gap-1 transition-opacity duration-150 lg:opacity-60 lg:group-hover:opacity-100 lg:focus-within:opacity-100">
          {ctx.canWrite && v.status !== 'retired' && (
            <IconButton size="sm" label={`Edit ${v.registration_number}`} icon={<Pencil />} onClick={() => ctx.onEdit(v)} />
          )}
          {ctx.canDelete && v.status !== 'retired' && (
            <IconButton
              size="sm"
              label={`Decommission ${v.registration_number}`}
              icon={<Archive />}
              onClick={() => ctx.onDecommission(v)}
              className="hover:bg-danger-soft hover:text-danger"
            />
          )}
        </div>
      ),
      skeleton: <span />,
    })
  }
  return columns
}

function DocumentsCell({ vehicle, ctx }: { vehicle: Vehicle; ctx: ColumnContext }) {
  const { health, isLoading, canWrite } = ctx.documents
  const h = health.get(vehicle.id)
  return (
    <div className="flex items-center gap-1">
      {isLoading ? (
        <Skeleton className="h-5 w-14 rounded-full" />
      ) : (
        <button
          type="button"
          onClick={() => ctx.onOpenDocuments(vehicle)}
          aria-label={`Documents for ${vehicle.registration_number}`}
          className="focus-ring rounded-full transition-transform duration-150 hover:scale-[1.03]"
        >
          {!h ? (
            <Badge tone="neutral" icon={<Paperclip />}>
              None
            </Badge>
          ) : h.expired > 0 ? (
            <Badge tone="danger" dot>
              {h.expired} expired
            </Badge>
          ) : h.expiring > 0 ? (
            <Badge tone="warning" dot>
              {h.expiring} expiring
            </Badge>
          ) : (
            <Badge tone="success" icon={<FileText />}>
              {h.total} on file
            </Badge>
          )}
        </button>
      )}
      {canWrite && vehicle.status !== 'retired' && (
        <IconButton size="sm" label={`Upload a document for ${vehicle.registration_number}`} icon={<Plus />} onClick={() => ctx.onAddDocument(vehicle)} />
      )}
    </div>
  )
}
