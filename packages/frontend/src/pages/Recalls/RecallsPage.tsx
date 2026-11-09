import { Eye, Megaphone, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, type Column } from '@/components/shared'
import { Badge, Button } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { seesEveryDepot } from '@/features/service-due'
import { RECALL_PAGE_SIZE, RECALL_STATUS, recallTarget, useRecalls, type Recall } from '@/features/warranty'
import { formatDay } from '@/pages/VehicleHistory/format'
import { RecallDrawer } from './RecallDrawer'
import { RecallFormDrawer } from './RecallFormDrawer'

/**
 * S-35 Recalls (FMS-133): the manufacturer recalls on record, newest first, with how many of the user's
 * vehicles each applies to and where their work stands. A user who sees every depot issues and corrects
 * them; each vehicle's recall work is booked or marked done from here or on its own page.
 */
export function RecallsPage() {
  const { hasPermission, session } = useAuth()
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '', 10) || 1)
  const canWrite = hasPermission('maintenance:write')
  const canIssue = canWrite && seesEveryDepot(session?.roles ?? [])
  const list = useRecalls(page)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Recall | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)
  // The open recall as the list has it now, so its counts follow a vehicle marked done.
  const viewing = useMemo(() => list.data?.recalls.find((r) => r.id === viewingId) ?? null, [list.data, viewingId])

  function openForm(recall: Recall | null) {
    setViewingId(null)
    setEditing(recall)
    setFormOpen(true)
  }

  const columns: Column<Recall>[] = [
    {
      key: 'recall',
      header: 'Recall',
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">
            <span className="tabular">{r.campaign_code}</span>
            <span className="ml-2 font-normal text-ink-muted">{recallTarget(r)}</span>
          </p>
          <p className="truncate text-xs text-ink-subtle">{r.description}</p>
        </div>
      ),
    },
    {
      key: 'issued',
      header: 'Issued',
      width: 'w-[136px]',
      hideBelow: 'md',
      cell: (r) => <span className="text-sm text-ink-muted">{r.issued_on ? formatDay(r.issued_on) : '—'}</span>,
    },
    {
      key: 'vehicles',
      header: 'Your vehicles',
      width: 'w-[240px]',
      cell: (r) =>
        r.vehicles.total === 0 ? (
          <span className="text-sm text-ink-subtle">None</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {(['open', 'scheduled', 'completed'] as const).map((s) =>
              r.vehicles[s] > 0 ? (
                <Badge key={s} tone={RECALL_STATUS[s].tone}>
                  {r.vehicles[s]} {RECALL_STATUS[s].label.toLowerCase()}
                </Badge>
              ) : null,
            )}
          </div>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[96px]',
      align: 'right',
      hideBelow: 'sm',
      cell: (r) => (
        <Button size="sm" variant="secondary" leadingIcon={<Eye className="h-3.5 w-3.5" />} onClick={(e) => {
            e.stopPropagation()
            setViewingId(r.id)
          }}
          aria-label={`View ${r.campaign_code}`}>
          View
        </Button>
      ),
      skeleton: <span />,
    },
  ]

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Recalls</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">Manufacturer campaigns, and the vehicles of each make, model and year they apply to.</p>
        </div>
        {canIssue && (
          <Button className="self-start sm:self-auto" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => openForm(null)}>
            Issue recall
          </Button>
        )}
      </header>

      <section aria-label="Recall list">
        <DataTable
          caption="Recalls"
          rowHeight="stacked"
          columns={columns}
          data={list.data?.recalls}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.campaign_code}
          onRowClick={(r) => setViewingId(r.id)}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          pagination={
            list.data
              ? {
                  page,
                  pageSize: RECALL_PAGE_SIZE,
                  totalItems: list.data.meta.total_items,
                  onPageChange: (next) => setParams(next > 1 ? { page: String(next) } : {}),
                }
              : undefined
          }
          emptyState={
            <EmptyState
              icon={<Megaphone />}
              heading="No recalls on record"
              description={
                canIssue
                  ? 'Issue a recall when a manufacturer announces one: every vehicle it applies to is listed, and its depot alerted.'
                  : 'Recalls are issued by those who see every depot. The vehicles they apply to show here and on each vehicle page.'
              }
              action={
                canIssue && (
                  <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => openForm(null)}>
                    Issue recall
                  </Button>
                )
              }
            />
          }
        />
      </section>

      <RecallDrawer recall={viewing} onClose={() => setViewingId(null)} onEdit={canIssue && viewing ? () => openForm(viewing) : undefined} canComplete={canWrite} />
      <RecallFormDrawer open={formOpen} onClose={() => setFormOpen(false)} recall={editing} />
    </div>
  )
}
