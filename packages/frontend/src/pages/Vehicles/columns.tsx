import { Activity, AlertTriangle, ArrowRight, Bike, Bus, Car, CarFront, FileText, MapPin, Paperclip, Pencil, Truck, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { StatusText, type Column } from '@/components/shared'
import { Badge, Button, cn, IconButton, Skeleton } from '@/components/ui'
import type { DocumentHealth } from '@/features/documents/expiry'
import { HealthBadge } from '@/features/health/HealthBadge'
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
  /** False when the chosen view is one status (every row would say the same). */
  showStatus?: boolean
  onEdit: (vehicle: Vehicle) => void
  onOpenDocuments: (vehicle: Vehicle) => void
  /** Status and availability (FMS-76): everyone who sees the list may open it. */
  onStatus: (vehicle: Vehicle) => void
  /** The health score's breakdown (FMS-56): given only with prediction:read; others see the badge alone. */
  onHealth?: (vehicle: Vehicle) => void
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
          <div className={cn('hidden h-9 w-9 shrink-0 items-center justify-center rounded-control ring-1 ring-inset sm:flex', v.maintenance_flag ? 'bg-warning-soft text-warning ring-warning/25' : 'bg-surface-sunken text-ink-muted ring-line')}>
            {(() => {
              const Icon = TYPE_ICONS[v.vehicle_type]
              return <Icon className="h-4 w-4" aria-hidden="true" />
            })()}
          </div>
          <div className="min-w-0">
            <p className="plate flex flex-wrap items-center gap-x-2 text-ink">
              <span className="whitespace-nowrap">{v.registration_number}</span>
              {v.maintenance_flag && (
                <Badge tone="warning" icon={<AlertTriangle />} className="shrink-0">
                  <span aria-hidden="true">Flagged</span>
                  <span className="sr-only">Flagged for maintenance</span>
                </Badge>
              )}
            </p>
            <p className="truncate text-xs text-ink-subtle" title={`${v.make} ${v.model}${v.year ? ` · ${v.year}` : ''}`}>
              {v.make} {v.model}
              {v.year ? ` · ${v.year}` : ''}
            </p>
            {/* Narrow screens drop columns; the facts that decide a dispatch ride under the name instead. */}
            <p className="truncate text-xs text-ink-subtle md:hidden">
              {ctx.depots.get(v.depot_id)?.name ?? '—'} · {v.current_trip ? `${v.current_trip.origin ?? 'Origin'} to ${v.current_trip.destination ?? 'Destination'}` : 'No active trip'}
            </p>
            <p className="hidden truncate text-xs text-ink-subtle md:block xl:hidden">{ctx.depots.get(v.depot_id)?.name ?? '—'}</p>
            <PhoneDocumentState health={ctx.documents.health.get(v.id)} />
          </div>
          {/* Below 1024px there is no Status column: only an exception earns the space, since "Active" is the normal state. */}
          {v.status !== 'active' && (
            <span className="ml-auto lg:hidden">
              <StatusText status={v.status} />
            </span>
          )}
        </div>
      ),
      skeleton: (
        <div className="flex items-center gap-3">
          <Skeleton className="hidden h-9 w-9 rounded-control sm:block" />
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
      sortKey: 'vehicle_type',
      width: 'w-[8%]',
      hideBelow: 'xl',
      optional: true,
      cell: (v) => <span className="text-ink-muted">{VEHICLE_TYPE_LABELS[v.vehicle_type]}</span>,
    },
    {
      key: 'depot',
      header: 'Depot',
      sortKey: 'depot',
      width: 'w-[15%]',
      hideBelow: 'xl',
      optional: true,
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
      sortKey: 'status',
      width: 'w-[128px]',
      hideBelow: 'lg',
      optional: true,
      cell: (v) => <StatusText status={v.status} />,
      skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
    },
    {
      key: 'health',
      header: 'Health',
      sortKey: 'health_score',
      width: 'w-[128px]',
      hideBelow: 'md',
      optional: true,
      label: 'Health score',
      cell: (v) => <HealthBadge score={v.health_score} updatedAt={v.health_score_updated_at} onOpen={ctx.onHealth ? () => ctx.onHealth!(v) : undefined} />,
      skeleton: <Skeleton className="h-6 w-14 rounded-full" />,
    },
    {
      key: 'trip',
      header: 'Current trip',
      width: 'w-[26%] xl:w-[19%]',
      hideBelow: 'md',
      optional: true,
      cell: (v) =>
        v.current_trip ? (
          <Link
            to={`/dispatch?trip=${v.current_trip.id}`}
            className="focus-ring group/trip -mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-brand-soft"
          >
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                v.current_trip.status === 'en_route' ? 'bg-amber-500' : 'bg-blue-500',
              )}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink group-hover/trip:text-brand-ink" title={`${v.current_trip.origin ?? 'Origin'} to ${v.current_trip.destination ?? 'Destination'}`}>
                {v.current_trip.origin ?? 'Origin'} <ArrowRight className="inline h-3 w-3" aria-label="to" /> {v.current_trip.destination ?? 'Destination'}
              </span>
              <span className="block text-xs text-ink-subtle">{v.current_trip.status === 'en_route' ? 'En route' : 'Assigned'}</span>
            </span>
          </Link>
        ) : (
          <span className="text-ink-subtle">
            <span aria-hidden="true">—</span>
            <span className="sr-only">No active trip</span>
          </span>
        ),
    },
  ]

  if (ctx.documents.canRead) {
    columns.push({
      key: 'documents',
      header: 'Documents',
      width: 'w-[136px]',
      hideBelow: 'md',
      optional: true,
      cell: (v) => <DocumentsCell vehicle={v} ctx={ctx} />,
      skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
    })
  }

  columns.push({
    key: 'actions',
    header: <span className="sr-only">Actions</span>,
    width: ctx.canWrite ? 'w-[144px] coarse:w-[156px]' : 'w-[56px] coarse:w-[64px]',
    align: 'right',
    cell: (v) => (
      <div className="flex items-center justify-end gap-1.5">
        <IconButton size="sm" label={`Availability of ${v.registration_number}`} icon={<Activity className="h-4 w-4" />} onClick={() => ctx.onStatus(v)} />
        {ctx.canWrite && v.status !== 'retired' && (
          <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" />} aria-label={`Edit ${v.registration_number}`} onClick={() => ctx.onEdit(v)}>
            Edit
          </Button>
        )}
      </div>
    ),
    skeleton: <span />,
  })
  return ctx.showStatus === false ? columns.filter((c) => c.key !== 'status') : columns
}

/** Below the widest layouts only, and only for an exception: an expired or expiring document is the one thing worth a line. */
function PhoneDocumentState({ health }: { health: DocumentHealth | undefined }) {
  if (!health || (health.expired === 0 && health.expiring === 0)) return null
  return (
    <p className={cn('truncate text-xs font-medium xl:hidden', health.expired > 0 ? 'text-danger' : 'text-warning')}>
      {health.expired > 0 ? `${health.expired} document${health.expired === 1 ? '' : 's'} expired` : `${health.expiring} document${health.expiring === 1 ? '' : 's'} expiring`}
    </p>
  )
}

function DocumentsCell({ vehicle, ctx }: { vehicle: Vehicle; ctx: ColumnContext }) {
  const { health, isLoading } = ctx.documents
  const h = health.get(vehicle.id)
  if (isLoading) return <Skeleton className="h-5 w-14 rounded-full" />
  return (
    <button
      type="button"
      onClick={() => ctx.onOpenDocuments(vehicle)}
      aria-label={`Documents for ${vehicle.registration_number}`}
      className="focus-ring inline-flex rounded-full coarse:min-h-11 coarse:min-w-11 coarse:items-center coarse:justify-center"
    >
      {!h ? (
        // Missing documents are a gap, but not an alarm: plain text, no pill.
        <span className="inline-flex items-center gap-1.5 px-1 text-sm text-ink-subtle">
          <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
          None
        </span>
      ) : h.expired > 0 ? (
        <Badge tone="danger" icon={<AlertTriangle />}>
          {h.expired} expired
        </Badge>
      ) : h.expiring > 0 ? (
        <Badge tone="warning" dot>
          {h.expiring} expiring
        </Badge>
      ) : (
        // Healthy is the normal state: the count, quietly, so the badges that remain are the exceptions.
        <span className="inline-flex items-center gap-1.5 px-1 text-sm text-ink-muted" title={`${h.total} document${h.total === 1 ? '' : 's'} on file`}>
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          {h.total}
          <span className="sr-only"> on file</span>
        </span>
      )}
    </button>
  )
}
