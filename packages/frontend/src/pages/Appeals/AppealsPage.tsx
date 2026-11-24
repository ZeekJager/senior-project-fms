import { AlarmClock, Building2, CircleCheck, Eye, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, type Column } from '@/components/shared'
import { Badge, Button, FilterSelect, Skeleton, ViewTabs } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { PAGE_SIZE, useAppealQueue, type Appeal, type AppealStatus } from '@/features/appeals/api'
import { dueLabel, reasonLabel, statusOf, targetLabel, when } from '@/features/appeals/describe'
import { AppealDrawer } from './AppealDrawer'

type View = 'open' | 'overdue' | 'decided' | 'closed'

const totalOf = (meta: Record<string, unknown> | undefined) => Number(meta?.total_items ?? 0)

const VIEWS: Record<View, { label: string; status: AppealStatus[]; overdue: boolean }> = {
  open: { label: 'To review', status: ['submitted', 'under_review'], overdue: false },
  overdue: { label: 'Overdue', status: ['submitted', 'under_review'], overdue: true },
  decided: { label: 'Decided', status: ['approved', 'rejected'], overdue: false },
  closed: { label: 'Closed', status: ['closed'], overdue: false },
}

/**
 * S-36 Score appeals (FMS-159): drivers' appeals and complaints about a flag, an incident or a month's score, in the
 * reviewer's depots, oldest first. Overdue ones (past the review deadline) are marked and have a view of their own. A
 * row opens the appeal with its evidence, timeline and thread; reviewers (appeal:review) claim and decide it there.
 */
export function AppealsPage() {
  const { hasPermission } = useAuth()
  const canPickDepot = hasPermission('depot:read')
  const [params, setParams] = useSearchParams()
  const view = (params.get('view') as View | null) ?? 'open'
  const depotId = params.get('depot') ?? ''
  const appealId = params.get('appeal')
  const [page, setPage] = useState(1)
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  const filters = useMemo(() => ({ status: VIEWS[view].status, overdue: VIEWS[view].overdue, depotId: depotId || null, page }), [view, depotId, page])
  const queue = useAppealQueue(filters)
  const overdue = useAppealQueue({ status: VIEWS.overdue.status, overdue: true, depotId: depotId || null, page: 1 })
  const depots = useDepots()
  const depotOptions = [{ value: '', label: 'All depots' }, ...(canPickDepot ? (depots.data ?? []) : []).map((d) => ({ value: d.id, label: d.name }))]

  const columns: Column<Appeal>[] = [
    {
      key: 'driver',
      header: 'Driver',
      width: 'w-[40%] sm:w-[24%]',
      cell: (a) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{a.driver.name}</p>
          <p className="truncate text-xs text-ink-subtle">{a.depot?.name ?? 'No depot'}</p>
        </div>
      ),
      skeleton: (
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      ),
    },
    {
      key: 'what',
      header: 'Against',
      cell: (a) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{targetLabel(a)}</p>
          <p className="truncate text-xs text-ink-subtle">
            {a.kind === 'complaint' ? 'Complaint' : 'Appeal'} · {reasonLabel(a.reason)}
            {a.attachments.length > 0 ? ` · ${a.attachments.length} file${a.attachments.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'sent',
      header: 'Sent',
      width: 'w-[16%]',
      hideBelow: 'md',
      cell: (a) => (
        <div className="min-w-0">
          <p className="tabular text-ink-muted">{when(a.submitted_at)}</p>
          {dueLabel(a) && <p className={a.overdue ? 'text-xs font-medium text-danger' : 'text-xs text-ink-subtle'}>{dueLabel(a)}</p>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-[20%]',
      hideBelow: 'lg',
      cell: (a) => {
        const s = statusOf(a)
        return (
          <div className="min-w-0">
            <Badge tone={a.overdue ? 'danger' : s.tone}>{a.overdue ? 'Overdue' : s.label}</Badge>
            <p className="mt-1 truncate text-xs text-ink-subtle">{a.decided_by ? `By ${a.decided_by.name}` : a.claimed_by ? `${a.claimed_by.name} is on it` : 'Not claimed'}</p>
          </div>
        )
      },
    },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[104px]',
      hideBelow: 'sm',
      align: 'right',
      cell: (a) => (
        <Button size="sm" variant={a.status === 'submitted' || a.status === 'under_review' ? 'secondary' : 'ghost'} leadingIcon={<Eye className="h-3.5 w-3.5" />} onClick={() => set({ appeal: a.id })} aria-label={`Open ${a.driver.name}'s appeal`}>
          {a.status === 'submitted' || a.status === 'under_review' ? 'Review' : 'View'}
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Score appeals</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">
            Drivers’ appeals and complaints about a flag, an incident or their score, oldest first. Decide each within 5 working days; past that it goes to the depot admin.
          </p>
        </div>
        {canPickDepot && (depots.data?.length ?? 0) > 1 && (
          <FilterSelect label="Depot" icon={<Building2 />} value={depotId} emptyValue="" options={depotOptions} onChange={(d) => {
              setPage(1)
              set({ depot: d || null })
            }} />
        )}
      </header>

      <DataTable
        toolbar={
          <ViewTabs
            label="Appeal views"
            value={view}
            options={(Object.keys(VIEWS) as View[]).map((v) => ({
              value: v,
              label: VIEWS[v].label,
              ...(v === 'overdue' ? { count: totalOf(overdue.data?.meta), isLoading: overdue.isPending } : {}),
            }))}
            onChange={(v) => {
              setPage(1)
              set({ view: v === 'open' ? null : v })
            }}
          />
        }
        caption={`Score appeals, ${VIEWS[view].label.toLowerCase()}, oldest first`}
        rowHeight="stacked3"
        tableId="score-appeals"
        rowLabel={(a) => `${a.driver.name}, ${targetLabel(a)}`}
        onRowClick={(a) => set({ appeal: a.id })}
        columns={columns}
        data={queue.data?.data}
        rowKey={(a) => a.id}
        isLoading={queue.isPending}
        error={queue.isError ? queue.error : undefined}
        onRetry={() => void queue.refetch()}
        pagination={
          totalOf(queue.data?.meta) > 0 ? { page, pageSize: PAGE_SIZE, totalItems: totalOf(queue.data?.meta), onPageChange: setPage } : undefined
        }
        emptyState={
          view === 'open' ? (
            <EmptyState icon={<CircleCheck />} heading="No appeals to review" description="When a driver appeals a flag, an incident or their score, it is listed here." />
          ) : view === 'overdue' ? (
            <EmptyState icon={<AlarmClock />} heading="Nothing overdue" description="Every open appeal is within its review deadline." />
          ) : (
            <EmptyState icon={<Search />} heading={`No ${VIEWS[view].label.toLowerCase()} appeals`} />
          )
        }
      />

      <AppealDrawer appealId={appealId} onClose={() => set({ appeal: null })} />
    </div>
  )
}
