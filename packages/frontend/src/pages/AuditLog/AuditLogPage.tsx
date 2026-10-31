import { Bot, CalendarDays, Database, Eye, History, Link2, ScrollText, Search, ShieldAlert, UserRound, UserX, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, ListToolbar, useCursorPages, type Column } from '@/components/shared'
import { Badge, Button, FilterSelect, Skeleton, type ViewOption } from '@/components/ui'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { AUDIT_PAGE_SIZE, isUuid, readFilters, useAuditLog, writeFilters, type AuditFilters, type AuditView } from './api'
import { actorName, recordName, summary, TABLES, tableLabel, type AuditEntry } from './describe'
import { EntryDrawer, entryTitle } from './EntryDrawer'

const TZ = 'Africa/Addis_Ababa'

const VIEW_OPTIONS: readonly ViewOption<AuditView>[] = [
  { value: 'changes', label: 'Data changes', hint: 'Records created, updated or deleted, and role changes' },
  { value: 'signins', label: 'Sign-ins', hint: 'Sign-ins, failed attempts, sign-outs and password changes' },
  { value: 'denied', label: 'Denied', hint: 'Requests refused for lack of permission' },
  { value: 'jobs', label: 'Scheduled jobs', hint: 'Nightly scoring, expiry checks and the other jobs' },
  { value: 'all', label: 'Everything', hint: 'Every entry, GPS position batches included', archived: true },
]

const TABLE_OPTIONS = [
  { value: '', label: 'All records' },
  ...Object.entries(TABLES)
    .map(([value, [, plural]]) => ({ value, label: plural }))
    .sort((a, b) => a.label.localeCompare(b.label)),
]

/** YYYY-MM-DD in Addis Ababa, `days` before today. */
function addisDay(daysAgo = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() - daysAgo * 86_400_000))
}

type Period = '' | 'today' | '7d' | '30d' | '90d' | 'custom'
const PRESETS: Record<Exclude<Period, '' | 'custom'>, number> = { today: 0, '7d': 6, '30d': 29, '90d': 89 }
const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: '', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Choose dates' },
]

function periodOf(f: AuditFilters): Period {
  if (!f.from && !f.to) return ''
  if (!f.to) for (const [period, back] of Object.entries(PRESETS)) if (f.from === addisDay(back)) return period as Period
  return 'custom'
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' })
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' })
const shortId = (id: string) => id.slice(0, 8)

/** A date filter that reads like the rest of the app ("21 Oct 2026") over the browser's own date field. */
function DatePill({ label, value, min, max, onChange }: { label: string; value: string; min?: string; max?: string; onChange: (value: string) => void }) {
  return (
    <label className="focus-within:ring-brand/20 relative inline-flex h-9 items-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-sm shadow-soft focus-within:ring-4 coarse:h-11">
      <CalendarDays className="h-4 w-4 text-ink-subtle" aria-hidden="true" />
      <span className="text-ink-muted">{label}</span>
      <span aria-hidden="true" className="tabular text-ink">
        {value ? day(`${value}T12:00:00Z`) : 'Any'}
      </span>
      <input
        type="date"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.currentTarget.showPicker?.()}
        className="absolute -inset-px h-[calc(100%+2px)] w-[calc(100%+2px)] cursor-pointer opacity-0"
      />
    </label>
  )
}

/** A filter the list is narrowed to, with the way out of it. */
function Chip({ icon, children, onRemove, removeLabel }: { icon: ReactNode; children: ReactNode; onRemove: () => void; removeLabel: string }) {
  return (
    <span className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-brand/30 bg-brand-soft pl-3 pr-1 text-sm text-brand-ink">
      <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">
        {icon}
      </span>
      <span className="truncate">{children}</span>
      <button type="button" onClick={onRemove} aria-label={removeLabel} className="focus-ring inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-brand/10">
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </span>
  )
}

function ActorCell({ entry }: { entry: AuditEntry }) {
  const actor = entry.actor
  const icon = actor.type === 'system' ? <Bot /> : actor.type === 'anonymous' ? <UserX /> : <UserRound />
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-0.5 shrink-0 text-ink-subtle [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className={`truncate text-sm ${actor.type === 'user' ? 'text-ink' : 'text-ink-muted'}`}>{actorName(actor, entry.action)}</p>
        {actor.type === 'user' && actor.email && actor.full_name && <p className="truncate text-xs text-ink-subtle">{actor.email}</p>}
      </div>
    </div>
  )
}

/**
 * S-10 Audit log (FMS-29): who changed what and when, for compliance reviews without database access.
 * Newest first, one view per kind of entry; an entry opens the fields it changed, before and after.
 * audit:read: administrators, fleet owners and compliance officers.
 */
export function AuditLogPage() {
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const update = (patch: Partial<AuditFilters>) => setParams(writeFilters({ ...filters, ...patch }), { replace: true })

  const pages = useCursorPages()
  const filterKey = writeFilters(filters).toString()
  useEffect(() => pages.reset(), [filterKey])
  const list = useAuditLog(filters, pages.cursor)

  const [recordText, setRecordText] = useState(filters.record)
  const debouncedRecord = useDebouncedValue(recordText.trim(), 300)
  const recordInvalid = debouncedRecord !== '' && !isUuid(debouncedRecord)
  useEffect(() => {
    const next = isUuid(debouncedRecord) ? debouncedRecord.toLowerCase() : ''
    if (!recordInvalid && next !== filters.record) update({ record: next })
  }, [debouncedRecord])
  useEffect(() => setRecordText(filters.record), [filters.record])

  // Names for the chips, remembered from the entry a lead was followed from; a shared link shows the id instead.
  const [names, setNames] = useState<{ user?: string; record?: string }>({})
  const [open, setOpen] = useState<AuditEntry | null>(null)
  const [choosingDates, setChoosingDates] = useState(false)
  const period: Period = choosingDates ? 'custom' : periodOf(filters)

  const follow = (entry: AuditEntry, patch: Partial<AuditFilters>) => {
    setNames((n) => ({
      user: patch.user ? actorName(entry.actor, entry.action) : n.user,
      record: patch.record ? `${tableLabel(entry.entity_type) ?? 'Record'}${recordName(entry) ? ` ${recordName(entry)}` : ''}` : n.record,
    }))
    setOpen(null)
    update(patch)
  }

  const narrowed = Boolean(filters.table || filters.record || filters.user || filters.request || filters.from || filters.to)
  const clearAll = () => {
    setRecordText('')
    setChoosingDates(false)
    update({ table: '', record: '', user: '', request: '', from: '', to: '' })
  }

  const columns: Column<AuditEntry>[] = [
    {
      key: 'when',
      header: 'When',
      width: 'w-[132px]',
      cell: (e) => (
        <div className="tabular text-sm">
          <p className="text-ink">{day(e.occurred_at)}</p>
          <p className="text-xs text-ink-subtle">{time(e.occurred_at)}</p>
        </div>
      ),
      skeleton: (
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3 w-14" />
        </div>
      ),
    },
    {
      key: 'what',
      header: 'What happened',
      cell: (e) => {
        const line = summary(e)
        return (
          <div className="min-w-0">
            <p className="flex min-w-0 items-start gap-2 sm:items-center">
              {/* Two lines on a phone, where the title is the row; one on wider screens. */}
              <span className="line-clamp-2 text-sm font-medium text-ink sm:truncate">{entryTitle(e)}</span>
              {e.result && e.result !== 'success' && (
                <Badge tone="danger" className="shrink-0">
                  {e.result === 'denied' ? 'Denied' : 'Failed'}
                </Badge>
              )}
            </p>
            {line && <p className="truncate text-xs text-ink-subtle">{line}</p>}
            {/* No Who column on a phone: the person leads the next line instead. */}
            <p className="truncate text-xs text-ink-muted md:hidden">{actorName(e.actor, e.action)}</p>
          </div>
        )
      },
    },
    {
      key: 'who',
      header: 'Who',
      width: 'w-[26%]',
      hideBelow: 'md',
      cell: (e) => <ActorCell entry={e} />,
    },
    {
      key: 'open',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[56px]',
      align: 'right',
      cell: (e) => (
        <Button size="sm" variant="ghost" onClick={() => setOpen(e)} aria-label={`Open ${entryTitle(e)}, ${day(e.occurred_at)} ${time(e.occurred_at)}`}>
          <Eye className="h-4 w-4" aria-hidden="true" />
        </Button>
      ),
      skeleton: <span />,
    },
  ]

  const chips = [
    filters.user && (
      <Chip key="user" icon={<UserRound />} onRemove={() => update({ user: '' })} removeLabel="Show everyone">
        By {names.user ?? `person ${shortId(filters.user)}`}
      </Chip>
    ),
    filters.record && (
      <Chip
        key="record"
        icon={<History />}
        onRemove={() => {
          setRecordText('')
          update({ record: '' })
        }}
        removeLabel="Show every record"
      >
        {names.record ?? `Record ${shortId(filters.record)}`}
      </Chip>
    ),
    filters.request && (
      <Chip key="request" icon={<Link2 />} onRemove={() => update({ request: '' })} removeLabel="Show every request">
        Request {shortId(filters.request)}
      </Chip>
    ),
  ].filter(Boolean)

  const viewLabel = VIEW_OPTIONS.find((v) => v.value === filters.view)!.label

  return (
    <div className="space-y-6">
      <header className="border-b border-line pb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Audit log</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Who changed what, and when. Every change to the system’s records is written here as it happens and can never be edited. Times are Addis Ababa time.
        </p>
      </header>

      <section aria-label="Audit entries">
        <DataTable
          toolbar={
            <div className="space-y-2 sm:space-y-3">
              <ListToolbar
                views={{ label: 'Audit views', value: filters.view, options: VIEW_OPTIONS, onChange: (view) => update({ view }) }}
                search={{ label: 'Find a record by its ID', placeholder: 'Record ID', value: recordText, onChange: setRecordText, busy: list.isFetching }}
                onClear={narrowed || recordText ? clearAll : undefined}
              >
                <FilterSelect label="Records" icon={<Database />} value={filters.table} emptyValue="" options={TABLE_OPTIONS} onChange={(table) => update({ table })} />
                <FilterSelect
                  label="When"
                  icon={<CalendarDays />}
                  value={period}
                  emptyValue=""
                  options={PERIOD_OPTIONS}
                  onChange={(p) => {
                    setChoosingDates(p === 'custom')
                    if (p === 'custom') return
                    update(p === '' ? { from: '', to: '' } : { from: addisDay(PRESETS[p]), to: '' })
                  }}
                />
                {period === 'custom' && (
                  <>
                    <DatePill label="From" value={filters.from} max={filters.to || addisDay()} onChange={(from) => update({ from })} />
                    <DatePill label="To" value={filters.to} min={filters.from || undefined} max={addisDay()} onChange={(to) => update({ to })} />
                  </>
                )}
              </ListToolbar>
              {recordInvalid && (
                <p role="status" className="text-xs text-warning">
                  A record ID is 36 characters, like 3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90. Copy it from the record’s page or from an entry.
                </p>
              )}
              {chips.length > 0 && (
                <div className="flex flex-wrap items-center gap-2" aria-label="Narrowed to">
                  {chips}
                </div>
              )}
            </div>
          }
          caption="Audit entries, newest first"
          rowHeight="stacked3"
          tableId="audit-log"
          rowLabel={(e) => `${entryTitle(e)}, ${day(e.occurred_at)} ${time(e.occurred_at)}`}
          rowClassName={(e) => (e.result && e.result !== 'success' ? 'bg-danger-soft/25' : undefined)}
          onRowClick={setOpen}
          columns={columns}
          data={list.data?.entries}
          rowKey={(e) => e.id}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          pagination={
            list.data
              ? {
                  kind: 'cursor',
                  pageIndex: pages.pageIndex,
                  pageSize: AUDIT_PAGE_SIZE,
                  hasNext: list.data.nextCursor !== null,
                  onNext: () => pages.next(list.data!.nextCursor),
                  onPrevious: pages.previous,
                }
              : undefined
          }
          emptyState={
            narrowed ? (
              <EmptyState
                icon={<Search />}
                heading={`No ${viewLabel.toLowerCase()} match`}
                description="Nothing was recorded for these filters. Try another view, a longer period, or clear the filters."
                action={
                  <Button variant="secondary" onClick={clearAll}>
                    Clear the filters
                  </Button>
                }
              />
            ) : filters.view === 'denied' ? (
              <EmptyState icon={<ShieldAlert />} heading="No denied requests" description="No one has been refused access to something they asked for." />
            ) : (
              <EmptyState icon={<ScrollText />} heading={`No ${viewLabel.toLowerCase()} yet`} description="Entries appear here as soon as they are recorded." />
            )
          }
        />
      </section>

      <EntryDrawer entry={open} onClose={() => setOpen(null)} onFilter={(patch) => open && follow(open, patch)} />
    </div>
  )
}
