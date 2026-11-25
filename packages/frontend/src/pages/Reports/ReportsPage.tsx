import { CalendarClock, Download, FileChartColumn, FileSpreadsheet, FileText, LoaderCircle, Sheet } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, type Column } from '@/components/shared'
import { Button, cn, useToast, ViewTabs } from '@/components/ui'
import { BACKGROUND_ROWS, openExport, readState, REPORT_OPTIONS, useDownloadReport, useExport, useReport, writeState, type DataFreshness, type ReportColumn, type ReportFormat, type ReportRow, type ScreenState } from './api'
import { columnWidth, displayValue, isNumeric } from './format'
import { DepotsFilter, FilterChips, MoreFilters, PeriodPicker, SavedFilters, VehicleTypeFilter } from './ReportControls'
import { SchedulesDrawer } from './SchedulesDrawer'

/** Behind the live database by more than this, the note says so. */
const NOTEWORTHY_LAG_SECONDS = 5
const PAGE_SIZES = [25, 50, 100] as const
const FORMAT_WORDS: Record<ReportFormat, string> = { csv: 'CSV', xlsx: 'Excel', pdf: 'PDF' }

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit' })
const until = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

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

/** The table's columns: right-aligned figures, each with its own width (a wide report scrolls sideways). */
function tableColumns(columns: readonly ReportColumn[]): Column<Line>[] {
  return columns.map((c) => ({
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
}

/** A background export being made, then its link (FMS-160: over 20,000 rows). */
function ExportNotice({ id, onDismiss }: { id: string; onDismiss: () => void }) {
  const exp = useExport(id)
  const e = exp.data
  const ready = e?.status === 'ready'
  const failed = e?.status === 'failed' || e?.status === 'expired'
  return (
    <div role="status" className={cn('flex flex-wrap items-center justify-between gap-3 rounded-card border px-4 py-3', failed ? 'border-danger/30 bg-danger-soft' : 'border-line bg-surface-muted')}>
      <div className="flex min-w-0 items-center gap-3">
        {ready ? <Download className="h-5 w-5 shrink-0 text-success" aria-hidden="true" /> : failed ? null : <LoaderCircle className="h-5 w-5 shrink-0 animate-spin text-ink-subtle" aria-hidden="true" />}
        <p className="text-sm text-ink">
          {ready
            ? `Your ${FORMAT_WORDS[e.format]} file of ${(e.rows ?? 0).toLocaleString()} rows is ready. The link works until ${until.format(new Date(e.expires_at!))}.`
            : failed
              ? `The file could not be made${e?.error ? `: ${e.error}` : ''}. Try again, or narrow the report.`
              : 'This report is large, so the file is being made in the background. You can keep working; it appears here when it is ready.'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {ready && (
          <Button leadingIcon={<Download className="h-4 w-4" />} onClick={() => openExport(e)}>
            Download
          </Button>
        )}
        <Button variant="ghost" onClick={onDismiss}>
          {ready || failed ? 'Dismiss' : 'Hide'}
        </Button>
      </div>
    </div>
  )
}

/**
 * S-28 Reports (FMS-91, FMS-160, docs/reports.md): eight reports for a month, a quarter, a year or a custom range,
 * narrowed by depots, vehicle type, vehicle, driver and route, in the user's depot scope. Previewed here with a totals
 * row; downloaded as CSV, Excel or PDF, all built by the server from the same table; emailed on a schedule. Needs
 * analytics:read.
 */
export function ReportsPage() {
  const { toast } = useToast()
  const [params, setParams] = useSearchParams()
  const state = useMemo(() => readState(params), [params])
  const update = (patch: Partial<ScreenState>) => setParams(writeState({ ...state, ...patch }), { replace: true })
  const apply = (next: ScreenState) => setParams(writeState(next), { replace: true })

  const report = useReport(state)
  const download = useDownloadReport()
  const [busy, setBusy] = useState<ReportFormat | null>(null)
  const [exportId, setExportId] = useState<string | null>(null)
  const [schedules, setSchedules] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  const filterKey = params.toString()
  useEffect(() => setPage(1), [filterKey])

  const option = REPORT_OPTIONS.find((o) => o.value === state.report)!
  const data = report.data?.report
  // Placeholder data from the last report shown while the next loads: never mix one report's rows with another's columns.
  const current = data && data.report === state.report ? data : undefined
  const rows = current?.rows
  const periodLabel = current?.period.label ?? ''

  const lines: Line[] | undefined = useMemo(() => {
    if (!rows) return undefined
    const shown: Line[] = rows.slice((page - 1) * pageSize, page * pageSize).map((row, i) => ({ key: String((page - 1) * pageSize + i), row, totals: false }))
    const last = page * pageSize >= rows.length
    return last && current?.totals ? [...shown, { key: 'totals', row: current.totals, totals: true }] : shown
  }, [rows, page, pageSize, current?.totals])

  async function save(format: ReportFormat) {
    setBusy(format)
    try {
      const queued = await download.mutateAsync({ state, format, rows: rows?.length ?? 0 })
      if (queued) {
        setExportId(queued.id)
        toast({ title: 'Making the file', description: `${(rows?.length ?? 0).toLocaleString()} rows take a moment. It appears above the table when ready.` })
      } else toast({ title: `${option.label} report downloading`, description: `${periodLabel}, as ${FORMAT_WORDS[format]}. Your browser saves it with your downloads.` })
    } catch {
      toast({ title: 'The report could not be downloaded', description: 'Check your connection and try again.', tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  const empty = rows !== undefined && rows.length === 0
  const scope = current?.filter_names.depots.length ? current.filter_names.depots.join(', ') : 'All your depots'
  const formats: { format: ReportFormat; icon: JSX.Element }[] = [
    { format: 'csv', icon: <FileSpreadsheet className="h-4 w-4" /> },
    { format: 'xlsx', icon: <Sheet className="h-4 w-4" /> },
    { format: 'pdf', icon: <FileText className="h-4 w-4" /> },
  ]

  return (
    <div className="space-y-6">
      <header className="space-y-4 border-b border-line pb-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Reports</h1>
            <p className="mt-1 max-w-xl text-sm text-ink-muted">Figures for management for any period. Check them here, download them for a spreadsheet or to share, or have them emailed on a schedule.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SavedFilters state={state} onApply={apply} />
            <Button variant="secondary" leadingIcon={<CalendarClock className="h-4 w-4" />} onClick={() => setSchedules(true)} aria-haspopup="dialog">
              Schedules
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodPicker state={state} onChange={update} />
          <DepotsFilter value={state.depotIds} onChange={(depotIds) => update({ depotIds })} />
          <VehicleTypeFilter value={state.vehicleType} onChange={(vehicleType) => update({ vehicleType })} />
          <MoreFilters state={state} names={current?.filter_names} onChange={update} />
        </div>
        <FilterChips state={state} names={current?.filter_names} onChange={update} />
      </header>

      <ViewTabs label="Reports" value={state.report} options={REPORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} onChange={(next) => update({ report: next })} />

      {exportId && <ExportNotice id={exportId} onDismiss={() => setExportId(null)} />}

      <section aria-labelledby="report-heading" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 max-w-2xl">
            <h2 id="report-heading" className="text-base font-semibold text-ink">
              {current?.title ?? `${option.label} report`}
              {periodLabel && `, ${periodLabel}`}
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">{option.description}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {rows && (
                <p className="text-xs text-ink-subtle">
                  {rows.length.toLocaleString()} {rows.length === 1 ? 'row' : 'rows'} · {scope}
                  {rows.length > BACKGROUND_ROWS && ' · downloads are made in the background'}
                </p>
              )}
              <Freshness freshness={report.data?.freshness} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Download">
            {formats.map(({ format, icon }) => (
              <Button key={format} variant="secondary" aria-label={`Download ${FORMAT_WORDS[format]}`} leadingIcon={icon} loading={busy === format} disabled={busy !== null || !rows} onClick={() => void save(format)}>
                {FORMAT_WORDS[format]}
              </Button>
            ))}
          </div>
        </div>

        <DataTable
          caption={`${option.label} report, ${periodLabel}`}
          tableId={`report-${state.report}`}
          columns={tableColumns(current?.columns ?? [])}
          data={lines}
          rowKey={(line) => line.key}
          rowClassName={(line) => (line.totals ? 'bg-surface-sunken/60' : undefined)}
          isLoading={report.isPending || (report.isFetching && !current)}
          error={report.isError ? report.error : undefined}
          onRetry={() => void report.refetch()}
          isEmpty={empty}
          emptyState={<EmptyState icon={<FileChartColumn />} heading={`${option.empty} in ${periodLabel || 'this period'}`} description="Nothing for these filters in that period. Try another period or fewer filters." />}
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

        {current?.sections?.map((section) => (
          <section key={section.title} aria-label={section.title} className="space-y-2 pt-2">
            <h3 className="text-sm font-semibold text-ink">{section.title}</h3>
            <DataTable
              caption={section.title}
              tableId={`report-${state.report}-${section.title}`}
              columns={tableColumns(section.columns)}
              data={section.rows.map((row, i) => ({ key: String(i), row, totals: false }))}
              rowKey={(line) => line.key}
              isLoading={false}
              isEmpty={section.rows.length === 0}
              emptyState={<p className="px-4 py-6 text-sm text-ink-muted">Nothing in this period.</p>}
            />
          </section>
        ))}
      </section>

      <SchedulesDrawer open={schedules} onClose={() => setSchedules(false)} state={state} />
    </div>
  )
}
