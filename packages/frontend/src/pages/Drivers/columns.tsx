import { ArrowRight, FileText, MapPin, Paperclip, Pencil, Plus, RotateCcw, UserMinus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { StatusBadge, type Column } from '@/components/shared'
import { Badge, cn, IconButton, Skeleton } from '@/components/ui'
import type { Depot } from '@/features/depots'
import { daysBetween, formatDate, today, type DocumentHealth } from '@/features/documents/expiry'
import type { Driver, LicenseStatus } from './types'

export interface ColumnContext {
  depots: Map<string, Depot>
  documents: { health: Map<string, DocumentHealth>; isLoading: boolean; canRead: boolean; canWrite: boolean }
  canWrite: boolean
  canDelete: boolean
  onEdit: (driver: Driver) => void
  onRetire: (driver: Driver) => void
  onReinstate: (driver: Driver) => void
  onOpenDocuments: (driver: Driver) => void
  onAddDocument: (driver: Driver) => void
}

/** Today's attendance that makes a driver a dispatch risk: a warning, not a block (FMS-21). */
const UNAVAILABLE: Partial<Record<NonNullable<Driver['attendance_today']>, string>> = {
  absent: 'Absent today',
  on_leave: 'On leave today',
  sick: 'Sick today',
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

// Avatar tints, picked from the name so a driver keeps their colour.
const AVATAR_TINTS = [
  'from-indigo-500 to-violet-500',
  'from-sky-500 to-indigo-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-fuchsia-500 to-purple-500',
]

function tintFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_TINTS[h % AVATAR_TINTS.length]
}

/**
 * The licence badge, from the API's licence_status (computed in Addis Ababa
 * time): red EXPIRED, amber EXPIRING SOON within 30 days, green otherwise.
 */
export function LicenceBadge({ status, expiry }: { status: LicenseStatus; expiry: string }) {
  if (status === 'expired') {
    return (
      <Badge tone="danger" dot className="tracking-wide">
        <span data-licence="expired">EXPIRED</span>
      </Badge>
    )
  }
  if (status === 'expiring_soon') {
    const days = daysBetween(today(), expiry)
    return (
      <Badge tone="warning" dot className="tracking-wide">
        <span data-licence="expiring_soon" title={days >= 0 ? `In ${days} day${days === 1 ? '' : 's'}` : undefined}>
          EXPIRING SOON
        </span>
      </Badge>
    )
  }
  return (
    <Badge tone="success" dot>
      <span data-licence="valid">Valid</span>
    </Badge>
  )
}

/** The driver table's columns; narrow screens keep name, licence and actions. */
export function driverColumns(ctx: ColumnContext): Column<Driver>[] {
  const columns: Column<Driver>[] = [
    {
      key: 'driver',
      header: 'Driver',
      sortKey: 'full_name',
      cell: (d) => (
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              'hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-xs font-semibold text-white sm:flex',
              tintFor(d.full_name),
            )}
            aria-hidden="true"
          >
            {initials(d.full_name)}
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink">{d.full_name}</p>
            {d.attendance_today && UNAVAILABLE[d.attendance_today] ? (
              <span className="mt-0.5 hidden sm:block">
                <Badge tone="warning">{UNAVAILABLE[d.attendance_today]}</Badge>
              </span>
            ) : (
              <p className="hidden truncate text-xs text-ink-subtle sm:block">{d.email}</p>
            )}
            {/* Phones drop the expiry column; the badge rides under the name. */}
            <span className="mt-1 block sm:hidden" aria-hidden="true">
              <LicenceBadge status={d.license_status} expiry={d.license_expiry} />
            </span>
          </div>
        </div>
      ),
      skeleton: (
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-36" />
          </div>
        </div>
      ),
    },
    {
      key: 'depot',
      header: 'Depot',
      width: 'w-[11%]',
      hideBelow: 'xl',
      cell: (d) => {
        const name = d.depot_id ? ctx.depots.get(d.depot_id)?.name : undefined
        return (
          <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />
            <span className="truncate" title={name}>
              {name ?? '—'}
            </span>
          </span>
        )
      },
    },
    {
      key: 'licence',
      header: 'Licence',
      sortKey: 'license_number',
      width: 'w-[12%]',
      hideBelow: 'lg',
      cell: (d) => (
        <div className="min-w-0">
          <p className="truncate font-medium tracking-wide text-ink">{d.license_number}</p>
          <p className="truncate text-xs text-ink-subtle">{d.license_categories.length ? d.license_categories.join(' · ') : 'No categories recorded'}</p>
        </div>
      ),
    },
    {
      key: 'expiry',
      header: 'Licence expiry',
      sortKey: 'license_expiry',
      width: 'w-[152px]',
      hideBelow: 'sm',
      cell: (d) => (
        <div className="min-w-0">
          <LicenceBadge status={d.license_status} expiry={d.license_expiry} />
          <p className="tabular mt-1 text-xs text-ink-subtle">{formatDate(d.license_expiry)}</p>
        </div>
      ),
      skeleton: (
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-3 w-20" />
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-[104px]',
      hideBelow: 'md',
      cell: (d) => <StatusBadge status={d.status} />,
      skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
    },
    {
      key: 'trip',
      header: 'Active trip',
      width: 'w-[14%]',
      hideBelow: 'lg',
      cell: (d) =>
        d.current_trip ? (
          <Link
            to={`/dispatch?trip=${d.current_trip.id}`}
            className="focus-ring group/trip -mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-brand-soft"
          >
            <span
              className={cn('h-2 w-2 shrink-0 rounded-full', d.current_trip.status === 'en_route' ? 'animate-pulse bg-amber-500' : 'bg-blue-500')}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink group-hover/trip:text-brand-ink">
                {d.current_trip.origin ?? 'Origin'} <ArrowRight className="inline h-3 w-3" aria-label="to" /> {d.current_trip.destination ?? 'Destination'}
              </span>
              <span className="block text-xs text-ink-subtle">{d.current_trip.status === 'en_route' ? 'En route' : 'Assigned'}</span>
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
      width: 'w-[144px]',
      hideBelow: 'md',
      cell: (d) => <DocumentsCell driver={d} ctx={ctx} />,
      skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
    })
  }

  if (ctx.canWrite || ctx.canDelete) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[96px]',
      align: 'right',
      cell: (d) => (
        <div className="flex justify-end gap-1 transition-opacity duration-150 lg:opacity-60 lg:group-hover:opacity-100 lg:focus-within:opacity-100">
          {ctx.canWrite && d.status === 'active' && (
            <IconButton size="sm" label={`Edit ${d.full_name}`} icon={<Pencil />} onClick={() => ctx.onEdit(d)} />
          )}
          {ctx.canDelete && d.status === 'active' && (
            <IconButton
              size="sm"
              label={`Retire ${d.full_name}`}
              icon={<UserMinus />}
              onClick={() => ctx.onRetire(d)}
              className="hover:bg-danger-soft hover:text-danger"
            />
          )}
          {ctx.canWrite && d.status === 'retired' && (
            <IconButton size="sm" label={`Reinstate ${d.full_name}`} icon={<RotateCcw />} onClick={() => ctx.onReinstate(d)} />
          )}
        </div>
      ),
      skeleton: <span />,
    })
  }
  return columns
}

function DocumentsCell({ driver, ctx }: { driver: Driver; ctx: ColumnContext }) {
  const { health, isLoading, canWrite } = ctx.documents
  const h = health.get(driver.id)
  return (
    <div className="flex items-center gap-1">
      {isLoading ? (
        <Skeleton className="h-5 w-14 rounded-full" />
      ) : (
        <button
          type="button"
          onClick={() => ctx.onOpenDocuments(driver)}
          aria-label={`Documents for ${driver.full_name}`}
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
      {canWrite && driver.status === 'active' && (
        <IconButton size="sm" label={`Upload a document for ${driver.full_name}`} icon={<Plus />} onClick={() => ctx.onAddDocument(driver)} />
      )}
    </div>
  )
}
