import { Building2, CalendarCheck, CalendarDays, ChevronLeft, ChevronRight, CircleSlash, ClipboardList, Palmtree, Search, UserCheck, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, StatCard, StatShare } from '@/components/shared'
import { Button, Card, cn, FilterSelect, IconButton, Skeleton, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { today } from '@/features/documents/expiry'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { AttendanceCard } from './AttendanceCard'
import { ATTENDANCE_STATUSES, ROSTER_PAGE_SIZE, useDayCounts, useMarkAttendance, useRoster, type AttendanceStatus, type RosterEntry, type RosterFilters } from './api'

const DATE = /^\d{4}-\d{2}-\d{2}$/

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function readFilters(params: URLSearchParams): RosterFilters {
  const date = params.get('date') ?? ''
  const status = params.get('status') ?? ''
  const page = Number.parseInt(params.get('page') ?? '', 10)
  return {
    date: DATE.test(date) ? date : today(),
    depotId: params.get('depot') ?? '',
    status: status === 'unmarked' || (ATTENDANCE_STATUSES as readonly string[]).includes(status) ? (status as RosterFilters['status']) : '',
    search: params.get('q') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  }
}

function writeFilters(f: RosterFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.date !== today()) p.set('date', f.date)
  if (f.depotId) p.set('depot', f.depotId)
  if (f.status) p.set('status', f.status)
  if (f.search) p.set('q', f.search)
  if (f.page > 1) p.set('page', String(f.page))
  return p
}

/**
 * S-06 Attendance (FMS-21): the day's roll call for the drivers of the
 * caller's depots, replacing the paper sheet. Each choice saves at once.
 */
export function AttendancePage() {
  const { hasPermission } = useAuth()
  const { toast } = useToast()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const canWrite = hasPermission('attendance:write')
  const isToday = filters.date === today()
  const future = filters.date > today()

  function update(patch: Partial<RosterFilters>) {
    setParams(writeFilters({ ...filters, page: 1, ...patch }), { replace: true })
  }

  const [searchText, setSearchText] = useState(filters.search)
  const debounced = useDebouncedValue(searchText, 300)
  // Runs only when the debounced text settles.
  useEffect(() => {
    if (debounced !== filters.search) update({ search: debounced })
  }, [debounced])

  const roster = useRoster(filters)
  const day = useDayCounts({ date: filters.date, depotId: filters.depotId, search: filters.search })
  const depots = useDepots()
  const depotMap = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d.name])), [depots.data])
  const mark = useMarkAttendance()
  const [bulkBusy, setBulkBusy] = useState(false)

  const entries = roster.data?.entries ?? []
  const unmarkedHere = entries.filter((e) => !e.attendance)
  const { counts } = day
  const pct = (n?: number) => (n === undefined || !counts.total ? 0 : Math.round((n * 100) / counts.total))

  async function markRestPresent() {
    setBulkBusy(true)
    let saved = 0
    for (const entry of unmarkedHere) {
      try {
        await mark.mutateAsync({ entry, status: 'present' })
        saved += 1
      } catch {
        // The card shows nothing here; the count below tells the clerk.
      }
    }
    setBulkBusy(false)
    toast({
      title: `${saved} driver${saved === 1 ? '' : 's'} marked present`,
      description: saved < unmarkedHere.length ? `${unmarkedHere.length - saved} could not be saved; mark them one by one.` : undefined,
      tone: saved < unmarkedHere.length ? 'danger' : 'success',
    })
  }

  const statusFilter = (s: RosterFilters['status']) => update({ status: filters.status === s ? '' : s })

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/70 px-2.5 py-1 text-xs font-medium text-ink-muted shadow-soft backdrop-blur">
            <ClipboardList className="h-3.5 w-3.5 text-brand-ink" aria-hidden="true" />
            Daily roll call
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Attendance</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            {longDate(filters.date)}
            {isToday && <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand-ink">Today</span>}
            {future && <span className="ml-2 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">Upcoming: leave only</span>}
          </p>
        </div>
        <nav aria-label="Day" className="flex items-center gap-2">
          <IconButton variant="secondary" label="Previous day" icon={<ChevronLeft />} onClick={() => update({ date: shiftDate(filters.date, -1) })} />
          <label className="focus-within:ring-brand/20 relative flex h-10 items-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-sm text-ink shadow-soft focus-within:ring-4">
            <CalendarDays className="h-4 w-4 text-ink-subtle" aria-hidden="true" />
            <span className="sr-only">Date</span>
            <input
              type="date"
              value={filters.date}
              onChange={(e) => DATE.test(e.target.value) && update({ date: e.target.value })}
              className="bg-transparent text-sm text-ink outline-none"
            />
          </label>
          <IconButton variant="secondary" label="Next day" icon={<ChevronRight />} onClick={() => update({ date: shiftDate(filters.date, 1) })} />
          {!isToday && (
            <Button variant="ghost" onClick={() => update({ date: today() })}>
              Today
            </Button>
          )}
        </nav>
      </header>

      <section aria-label="Day summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="Present"
          value={counts.present}
          isLoading={day.isLoading}
          icon={<UserCheck />}
          tone="success"
          pressed={filters.status === 'present'}
          onClick={() => statusFilter('present')}
          footer={<StatShare value={pct(counts.present)} tone="success" caption="of drivers on duty" />}
        />
        <StatCard
          label="Absent"
          value={counts.absent}
          isLoading={day.isLoading}
          icon={<CircleSlash />}
          tone="danger"
          pressed={filters.status === 'absent'}
          onClick={() => statusFilter('absent')}
          footer={<StatShare value={pct(counts.absent)} tone="danger" caption="flagged to dispatch" />}
        />
        <StatCard
          label="On leave"
          value={counts.onLeave}
          isLoading={day.isLoading}
          icon={<Palmtree />}
          tone="warning"
          pressed={filters.status === 'on_leave'}
          onClick={() => statusFilter('on_leave')}
          footer={<StatShare value={pct(counts.onLeave)} tone="warning" caption="planned absence" />}
        />
        <StatCard
          label="Not marked"
          value={counts.unmarked}
          isLoading={day.isLoading}
          icon={<Users />}
          tone="brand"
          pressed={filters.status === 'unmarked'}
          onClick={() => statusFilter('unmarked')}
          footer={<StatShare value={pct(counts.unmarked)} tone="brand" caption="still to record" />}
        />
      </section>

      <section aria-label="Drivers" className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 lg:max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search drivers"
              placeholder="Search name, email or licence number"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="focus-ring h-10 w-full rounded-control border border-line-strong bg-surface pl-10 pr-4 text-sm text-ink shadow-soft placeholder:text-ink-subtle hover:border-ink-subtle/50 focus:border-brand"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(depots.data?.length ?? 0) > 1 && (
              <FilterSelect
                label="Depot"
                icon={<Building2 />}
                value={filters.depotId}
                emptyValue=""
                options={[{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]}
                onChange={(depotId) => update({ depotId })}
              />
            )}
            {canWrite && !future && unmarkedHere.length > 0 && (
              <Button variant="secondary" leadingIcon={<CalendarCheck className="h-4 w-4" />} loading={bulkBusy} onClick={() => void markRestPresent()}>
                Mark {unmarkedHere.length} unmarked present
              </Button>
            )}
          </div>
        </div>

        {roster.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy="true">
            {Array.from({ length: 8 }, (_, i) => (
              <Card key={i} className="p-4" data-testid="skeleton-card">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
                <Skeleton className="mt-4 h-11 w-full rounded-control" />
                <Skeleton className="mt-3 h-3 w-40" />
              </Card>
            ))}
          </div>
        ) : roster.isError ? (
          <Card>
            <ErrorState error={roster.error} heading="We couldn't load the roll call" onRetry={() => void roster.refetch()} />
          </Card>
        ) : entries.length === 0 ? (
          <Card>
            {filters.status || filters.search ? (
              <EmptyState
                icon={<Search />}
                heading="No drivers match"
                description="Try another search or clear the filter."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearchText('')
                      update({ status: '', search: '' })
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState icon={<Users />} heading="No drivers in this depot" description="Drivers appear here once they are registered on the Drivers screen." />
            )}
          </Card>
        ) : (
          <>
            <div className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4', roster.isFetching && 'opacity-90')}>
              {entries.map((entry: RosterEntry) => (
                <AttendanceCard
                  key={entry.driver_id}
                  entry={entry}
                  depotName={entry.depot_id ? depotMap.get(entry.depot_id) : undefined}
                  canWrite={canWrite}
                  future={future}
                  onMark={(e, status: AttendanceStatus) => mark.mutateAsync({ entry: e, status })}
                />
              ))}
            </div>
            {(roster.data?.meta.total_pages ?? 1) > 1 && (
              <nav aria-label="Pagination" className="flex items-center justify-end gap-2">
                <span className="text-sm text-ink-muted">
                  Page {filters.page} of {roster.data!.meta.total_pages} · {ROSTER_PAGE_SIZE} per page
                </span>
                <IconButton variant="secondary" label="Previous page" icon={<ChevronLeft />} disabled={filters.page <= 1} onClick={() => setParams(writeFilters({ ...filters, page: filters.page - 1 }))} />
                <IconButton
                  variant="secondary"
                  label="Next page"
                  icon={<ChevronRight />}
                  disabled={filters.page >= roster.data!.meta.total_pages}
                  onClick={() => setParams(writeFilters({ ...filters, page: filters.page + 1 }))}
                />
              </nav>
            )}
          </>
        )}
      </section>
    </div>
  )
}
