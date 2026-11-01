import { Building2, FileChartColumn, FileSpreadsheet, FileText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, MonthStepper, type Column } from '@/components/shared'
import { Button, cn, FilterSelect, useToast, ViewTabs } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { monthLabel } from '@/lib/month'
import { readState, REPORT_OPTIONS, useDownloadReport, useReport, writeState, type DataFreshness, type ReportFormat, type ReportRow, type ScreenState } from './api'
import { columnWidth, displayValue, isNumeric } from './format'

/** Behind the live database by more than this, the note says so. */
const NOTEWORTHY_LAG_SECONDS = 5
const PAGE_SIZES = [25, 50, 100] as const

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit' })

function Freshness({ freshness }: { freshness: DataFreshness | undefined }) {
  if (!freshness) return null
  const lagging = freshness.source === 'replica' && freshness.lag_seconds >= NOTEWORTHY_LAG_SECONDS
  return (
    <p className="text-xs text-ink-subtle" title={freshness.source === 'replica' ? 'Read from the reporting copy of the database' : 'Read from the live database'}>
      Data as of {clock.format(new Date(freshness.as_of))}
      {lagging && <span className="text-warning"> · {freshness.lag_seconds.toLocaleString()} s behind live</span>}
    </p>
  )
}

/** A row of the preview: the report's, or its totals. */
interface Line {
  /** Its place in the report, or "totals". */
  key: string
  row: ReportRow
  totals: boolean
}

/**
 * S-28 Reports (FMS-91, docs/reports.md): monthly fuel, maintenance and cost per vehicle, the trip history and driver
 * performance, for the user's depots or one of them. Previewed here with a totals row; downloaded as CSV for a
 * spreadsheet or PDF to share, both built by the server from the same table. Needs analytics:read.
 */
export function ReportsPage() {
  const { hasPermission } = useAuth()
  const { toast } = useToast()
  const canPickDepot = hasPermission('depot:read')
  const [params, setParams] = useSearchParams()
  const state = useMemo(() => readState(params), [params])
  const update = (patch: Partial<ScreenState>) => setParams(writeState({ ...state, ...patch }), { replace: true })

  const depots = useDepots()
  const report = useReport(state)
  const download = useDownloadReport()
  const [busy, setBusy] = useState<ReportFormat | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  useEffect(() => setPage(1), [state.report, state.month, state.depotId])

  const option = REPORT_OPTIONS.find((o) => o.value === state.report)!
  const data = report.data?.report
  // Placeholder data from the last report shown while the next loads: never mix one report's rows with another's columns.
  const current = data && data.report === state.report ? data : undefined
  const rows = current?.rows
  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]

  const lines: Line[] | undefined = useMemo(() => {
    if (!rows) return undefined
    const shown: Line[] = rows.slice((page - 1) * pageSize, page * pageSize).map((row, i) => ({ key: String((page - 1) * pageSize + i), row, totals: false }))
    const last = page * pageSize >= rows.length
    return last && current?.totals ? [...shown, { key: 'totals', row: current.totals, totals: true }] : shown
  }, [rows, page, pageSize, current?.totals])

  // Every column keeps a width of its own: a report is wide, and on a narrow screen the table scrolls sideways rather
  // than squeezing nine figures into it.
  const columns: Column<Line>[] = (current?.columns ?? []).map((c) => ({
    key: c.key,
    header: c.label,
    align: isNumeric(c.kind) ? 'right' : 'left',
    width: columnWidth(c),
    cell: (line) => {
      const text = displayValue(c.kind, line.row[c.key] ?? null)
      return (
        <span className={cn('block truncate', isNumeric(c.kind) && 'tabular', line.totals && 'font-semibold text-ink')} title={text}>
          {text}
        </span>
      )
    },
  }))

  async function save(format: ReportFormat) {
    setBusy(format)
    try {
      await download.mutateAsync({ state, format })
      toast({ title: `${option.label} report downloading`, description: `${monthLabel(state.month)}, as ${format.toUpperCase()}. Your browser saves it with your downloads.` })
    } catch {
      toast({ title: 'The report could not be downloaded', description: 'Check your connection and try again.', tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  const empty = rows !== undefined && rows.length === 0
  const scopeName = state.depotId ? (depots.data?.find((d) => d.id === state.depotId)?.name ?? 'this depot') : 'your depots'

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Reports</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">Monthly figures for management. Check them here, then download a CSV for a spreadsheet or a PDF to share.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthStepper month={state.month} onChange={(month) => update({ month })} />
          {canPickDepot && (depots.data?.length ?? 0) > 1 && (
            <FilterSelect label="Depot" icon={<Building2 />} value={state.depotId} emptyValue="" options={depotOptions} onChange={(depotId) => update({ depotId })} />
          )}
        </div>
      </header>

      <ViewTabs label="Reports" value={state.report} options={REPORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} onChange={(next) => update({ report: next })} />

      <section aria-labelledby="report-heading" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 max-w-2xl">
            <h2 id="report-heading" className="text-base font-semibold text-ink">
              {current?.title ?? `${option.label} report`}, {monthLabel(state.month)}
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">{option.description}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {rows && (
                <p className="text-xs text-ink-subtle">
                  {rows.length.toLocaleString()} {rows.length === 1 ? 'row' : 'rows'} · {current?.depot?.name ?? 'All your depots'}
                </p>
              )}
              <Freshness freshness={report.data?.freshness} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" leadingIcon={<FileSpreadsheet className="h-4 w-4" />} loading={busy === 'csv'} disabled={busy !== null || !rows} onClick={() => void save('csv')}>
              Download CSV
            </Button>
            <Button variant="secondary" leadingIcon={<FileText className="h-4 w-4" />} loading={busy === 'pdf'} disabled={busy !== null || !rows} onClick={() => void save('pdf')}>
              Download PDF
            </Button>
          </div>
        </div>

        <DataTable
          caption={`${option.label} report, ${monthLabel(state.month)}`}
          tableId={`report-${state.report}`}
          columns={columns}
          data={lines}
          rowKey={(line) => line.key}
          rowClassName={(line) => (line.totals ? 'bg-surface-sunken/60' : undefined)}
          isLoading={report.isPending || (report.isFetching && !current)}
          error={report.isError ? report.error : undefined}
          onRetry={() => void report.refetch()}
          isEmpty={empty}
          emptyState={<EmptyState icon={<FileChartColumn />} heading={`${option.empty} in ${monthLabel(state.month)}`} description={`Nothing for ${scopeName} that month. Try another month or depot.`} />}
          pagination={
            rows && rows.length > 0
              ? {
                  page,
                  pageSize,
                  totalItems: rows.length,
                  onPageChange: setPage,
                  onPageSizeChange: (size) => {
                    setPageSize(size)
                    setPage(1)
                  },
                  pageSizes: PAGE_SIZES,
                }
              : undefined
          }
        />
      </section>
    </div>
  )
}
