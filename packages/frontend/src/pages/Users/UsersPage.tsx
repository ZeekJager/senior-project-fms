import { Activity, Building2, PauseCircle, Pencil, Search, ShieldCheck, UserCheck, UserCog, UserPlus, UserX, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, StatCard, StatShare, type Column } from '@/components/shared'
import { Badge, Button, FilterSelect, Spinner } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useRoles, useUserCounts, useUsers, type User, type UserFilters, type UserStatus } from './api'
import { PasswordLinkDialog } from './PasswordLinkDialog'
import { RolesDrawer } from './RolesDrawer'
import { roleLabel, STATUS_LABELS } from './roles'
import { UserFormDrawer, type IssuedLink } from './UserFormDrawer'

const STATUSES: UserStatus[] = ['active', 'suspended', 'locked', 'inactive']

function readFilters(params: URLSearchParams): UserFilters {
  const status = params.get('status') as UserStatus | null
  const page = Number.parseInt(params.get('page') ?? '', 10)
  return {
    search: params.get('q') ?? '',
    role: params.get('role') ?? '',
    status: status && STATUSES.includes(status) ? status : '',
    depotId: params.get('depot') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: 25,
  }
}

function writeFilters(f: UserFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.search) p.set('q', f.search)
  if (f.role) p.set('role', f.role)
  if (f.status) p.set('status', f.status)
  if (f.depotId) p.set('depot', f.depotId)
  if (f.page > 1) p.set('page', String(f.page))
  return p
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase()
}

const lastSeen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'

export function UserStatusBadge({ user }: { user: User }) {
  if (user.status === 'active' && !user.has_password) {
    return (
      <Badge tone="info" dot>
        Invited
      </Badge>
    )
  }
  const { label, tone } = STATUS_LABELS[user.status]
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  )
}

/**
 * Users and roles (FMS-78): who can sign in and what they may do. Readers
 * (users:read) see the directory; admins (users:write) invite people, change
 * roles and deactivate accounts. The server enforces every rule; the screen
 * only hides what would be refused.
 */
export function UsersPage() {
  const { session, hasPermission } = useAuth()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const canWrite = hasPermission('users:write')
  const canReadRoles = hasPermission('roles:read')

  function update(patch: Partial<UserFilters>) {
    setParams(writeFilters({ ...filters, page: 1, ...patch }), { replace: true })
  }

  const [searchText, setSearchText] = useState(filters.search)
  const debounced = useDebouncedValue(searchText, 300)
  // Runs only when the debounced text settles.
  useEffect(() => {
    if (debounced !== filters.search) update({ search: debounced })
  }, [debounced])

  const list = useUsers(filters)
  const stats = useUserCounts()
  const roles = useRoles(canReadRoles)
  const depots = useDepots()
  const depotNames = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d.name])), [depots.data])

  const [editing, setEditing] = useState<User | null>(null)
  const [creating, setCreating] = useState(false)
  const [link, setLink] = useState<IssuedLink | null>(null)
  const [showRoles, setShowRoles] = useState(false)

  const columns: Column<User>[] = [
    {
      key: 'user',
      header: 'User',
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink"
          >
            {initials(u.full_name)}
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate font-semibold text-ink">
              <span className="truncate">{u.full_name}</span>
              {u.id === session?.user.id && (
                <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 py-px text-2xs font-semibold uppercase tracking-wider text-ink-muted">You</span>
              )}
            </p>
            <p className="truncate text-xs text-ink-subtle">{u.email}</p>
            {/* Phones drop the status column; the badge rides under the name. */}
            <span className="mt-1 block md:hidden" aria-hidden="true">
              <UserStatusBadge user={u} />
            </span>
          </div>
        </div>
      ),
    },
    {
      key: 'roles',
      header: 'Roles',
      width: 'w-[30%]',
      hideBelow: 'sm',
      cell: (u) => (
        <div className="flex flex-wrap gap-1">
          {u.roles.length === 0 ? (
            <span className="text-xs text-ink-subtle">No role</span>
          ) : (
            u.roles.map((r) => (
              <Badge key={r} tone={r === 'admin' ? 'brand' : 'neutral'}>
                {roleLabel(r)}
              </Badge>
            ))
          )}
        </div>
      ),
    },
    {
      key: 'depot',
      header: 'Home depot',
      width: 'w-[150px]',
      hideBelow: 'lg',
      cell: (u) => <span className="truncate text-sm text-ink-muted">{u.depot_id ? (depotNames.get(u.depot_id) ?? 'Depot') : 'Every depot'}</span>,
    },
    { key: 'status', header: 'Status', width: 'w-[132px]', hideBelow: 'md', cell: (u) => <UserStatusBadge user={u} /> },
    { key: 'seen', header: 'Last sign-in', width: 'w-[170px]', hideBelow: 'xl', cell: (u) => <span className="tabular text-sm text-ink-muted">{lastSeen(u.last_login_at)}</span> },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            width: 'w-[64px] sm:w-[96px]',
            align: 'right' as const,
            cell: (u: User) => (
              <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(u)} aria-label={`Edit ${u.full_name}`}>
                <span className="hidden sm:inline">Edit</span>
              </Button>
            ),
            skeleton: <span />,
          },
        ]
      : []),
  ]

  const statusFilter = (s: UserStatus) => update({ status: filters.status === s ? '' : s })
  const pct = (n?: number) => (n === undefined || !stats.counts.total ? 0 : Math.round((n * 100) / stats.counts.total))
  const filtered = Boolean(filters.search || filters.role || filters.status || filters.depotId)

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Users and roles</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">Who can sign in and what they may do. Every role change is recorded in the audit log.</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0 sm:flex-nowrap">
          {canReadRoles && (
            <Button variant="secondary" leadingIcon={<ShieldCheck className="h-4 w-4" />} onClick={() => setShowRoles(true)}>
              Roles
            </Button>
          )}
          {canWrite && (
            <Button leadingIcon={<UserPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Invite user
            </Button>
          )}
        </div>
      </header>

      <section aria-label="Account summary" className="stat-strip">
        <StatCard label="Accounts" value={stats.counts.total} isLoading={stats.isLoading} icon={<UserCog />} tone="brand" pressed={!filters.status} onClick={() => update({ status: '' })} footer={<StatShare value={pct(stats.counts.active)} tone="brand" caption="can sign in" />} />
        <StatCard label="Active" value={stats.counts.active} isLoading={stats.isLoading} icon={<UserCheck />} tone="success" pressed={filters.status === 'active'} onClick={() => statusFilter('active')} footer={<StatShare value={pct(stats.counts.active)} tone="success" caption="of all accounts" />} />
        <StatCard label="Suspended" value={stats.counts.suspended} isLoading={stats.isLoading} icon={<PauseCircle />} tone="warning" pressed={filters.status === 'suspended'} onClick={() => statusFilter('suspended')} footer={<StatShare value={pct(stats.counts.suspended)} tone="warning" caption="temporarily blocked" />} />
        <StatCard label="Deactivated" value={stats.counts.inactive} isLoading={stats.isLoading} icon={<UserX />} tone="danger" pressed={filters.status === 'inactive'} onClick={() => statusFilter('inactive')} footer={<StatShare value={pct(stats.counts.inactive)} tone="danger" caption="no longer sign in" />} />
      </section>

      <section aria-label="Users" className="space-y-0">

        <DataTable

          toolbar={
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 lg:max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search users"
              placeholder="Search name or email"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="focus-ring h-9 w-full rounded-control border border-line-strong bg-surface-muted pl-10 pr-10 text-sm text-ink  placeholder:text-ink-subtle hover:border-ink-subtle/50 focus:border-brand"
            />
            {list.isFetching && searchText && <Spinner className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />}
          </div>
          <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap [&>button]:col-span-2 sm:[&>button]:col-auto">
            {canReadRoles && (
              <FilterSelect
                label="Role"
                icon={<ShieldCheck />}
                value={filters.role}
                emptyValue=""
                options={[{ value: '', label: 'All roles' }, ...(roles.data ?? []).map((r) => ({ value: r.name, label: roleLabel(r.name) }))]}
                onChange={(role) => update({ role })}
              />
            )}
            <FilterSelect
              label="Status"
              icon={<Activity />}
              value={filters.status}
              emptyValue=""
              options={[{ value: '' as const, label: 'Any status' }, ...STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s].label }))]}
              onChange={(status) => update({ status })}
            />
            {(depots.data?.length ?? 0) > 1 && (
              <FilterSelect label="Depot" icon={<Building2 />} value={filters.depotId} emptyValue="" options={[{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]} onChange={(depotId) => update({ depotId })} />
            )}
            {filtered && (
              <Button
                variant="ghost"
                leadingIcon={<X className="h-4 w-4" />}
                onClick={() => {
                  setSearchText('')
                  update({ search: '', role: '', status: '', depotId: '' })
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>

          }
          caption="Users"
          rowHeight="stacked"
          columns={columns}
          data={list.data?.users}
          rowKey={(u) => u.id}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          pagination={list.data ? { page: filters.page, pageSize: filters.pageSize, totalItems: list.data.meta.total_items, onPageChange: (page) => setParams(writeFilters({ ...filters, page })) } : undefined}
          emptyState={
            filtered ? (
              <EmptyState icon={<Search />} heading="No users match" description="Try another search or clear the filters." />
            ) : (
              <EmptyState icon={<UserCog />} heading="No users yet" description="Invite the first person to give them access." />
            )
          }
        />
      </section>

      {canWrite && (
        <UserFormDrawer
          open={creating || editing !== null}
          user={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onLink={setLink}
        />
      )}
      <PasswordLinkDialog link={link} onClose={() => setLink(null)} />
      {canReadRoles && <RolesDrawer open={showRoles} onClose={() => setShowRoles(false)} />}
    </div>
  )
}
