import { ArrowLeft, CalendarClock, CheckCircle2, CircleAlert, CircleX, History, Link2, Paperclip, Pencil, Plus, RotateCw, Trash2, UserX, X } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog, EmptyState } from '@/components/shared'
import { Badge, Button, Combobox, Drawer, IconButton, SelectField, Skeleton, TextField, useToast, type BadgeTone } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import {
  REPORT_OPTIONS,
  savedBody,
  useDeleteSchedule,
  useRecipients,
  useSaveSchedule,
  useScheduleRuns,
  useSchedules,
  type Frequency,
  type Person,
  type ReportFormat,
  type ReportKind,
  type Schedule,
  type ScheduleInput,
  type ScheduleRun,
  type ScreenState,
} from './api'

// Report schedules (FMS-160): a report emailed daily, weekly or monthly to FMS users, each checked when it is sent;
// attached up to 5 MB, else a link valid 7 days; a failed send retried 3 times; each schedule's run history.

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const FORMATS: readonly { value: ReportFormat; label: string }[] = [
  { value: 'xlsx', label: 'Excel (.xlsx)' },
  { value: 'pdf', label: 'PDF' },
  { value: 'csv', label: 'CSV' },
]
const FREQUENCIES: readonly { value: Frequency; label: string }[] = [
  { value: 'daily', label: 'Daily, for the day before' },
  { value: 'weekly', label: 'Weekly, for the week before' },
  { value: 'monthly', label: 'Monthly, for the month before' },
]
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`
const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', day: 'numeric', month: 'short', year: 'numeric' })

/** "Every Monday at 07:00", "Daily at 06:00", "Monthly on the 1st at 06:00" (Addis Ababa). */
export function cadence(s: Pick<Schedule, 'frequency' | 'day' | 'hour'>): string {
  const at = `${String(s.hour).padStart(2, '0')}:00`
  if (s.frequency === 'daily') return `Daily at ${at}`
  if (s.frequency === 'weekly') return `Every ${WEEKDAYS[(s.day ?? 1) - 1]} at ${at}`
  return `Monthly on the ${ordinal(s.day ?? 1)} at ${at}`
}

const reportLabel = (kind: string) => REPORT_OPTIONS.find((o) => o.value === kind)?.label ?? kind

const RUN_STATUS: Record<ScheduleRun['status'], { label: string; tone: BadgeTone }> = {
  running: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'success' },
  partial: { label: 'Partly sent', tone: 'warning' },
  retrying: { label: 'Retrying', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
}

const REASONS: Record<string, string> = { inactive: 'Account no longer active', no_access: 'No longer has access to reports' }

type View = { kind: 'list' } | { kind: 'form'; schedule: Schedule | null } | { kind: 'runs'; schedule: Schedule }

export function SchedulesDrawer({ open, onClose, state }: { open: boolean; onClose: () => void; state: ScreenState }) {
  const [view, setView] = useState<View>({ kind: 'list' })
  const close = () => {
    setView({ kind: 'list' })
    onClose()
  }
  const title = view.kind === 'form' ? (view.schedule ? 'Change schedule' : 'New schedule') : view.kind === 'runs' ? view.schedule.name : 'Scheduled reports'
  const description =
    view.kind === 'runs'
      ? `${reportLabel(view.schedule.report)} · ${cadence(view.schedule)}`
      : view.kind === 'form'
        ? 'Sent by email to the people you choose. Each gets the report as they are allowed to see it.'
        : 'Reports emailed on a schedule, to people in FMS.'
  return (
    <Drawer open={open} onClose={close} title={title} description={description} className="w-[min(560px,calc(100vw-16px))]">
      {view.kind !== 'list' && (
        <Button variant="ghost" size="sm" leadingIcon={<ArrowLeft className="h-4 w-4" />} onClick={() => setView({ kind: 'list' })} className="-ml-2 mb-4">
          All schedules
        </Button>
      )}
      {view.kind === 'list' && <ScheduleList onNew={() => setView({ kind: 'form', schedule: null })} onEdit={(s) => setView({ kind: 'form', schedule: s })} onRuns={(s) => setView({ kind: 'runs', schedule: s })} />}
      {view.kind === 'form' && <ScheduleForm schedule={view.schedule} state={state} onDone={() => setView({ kind: 'list' })} />}
      {view.kind === 'runs' && <RunHistory schedule={view.schedule} />}
    </Drawer>
  )
}

function ScheduleList({ onNew, onEdit, onRuns }: { onNew: () => void; onEdit: (s: Schedule) => void; onRuns: (s: Schedule) => void }) {
  const schedules = useSchedules()
  const remove = useDeleteSchedule()
  const { toast } = useToast()
  const [deleting, setDeleting] = useState<Schedule | null>(null)
  const list = schedules.data ?? []
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={onNew}>
          New schedule
        </Button>
      </div>
      {schedules.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={<CalendarClock />} heading="No reports are scheduled" description="Schedule this report to arrive by email every day, week or month." />
      ) : (
        <ul className="space-y-3" aria-label="Schedules">
          {list.map((s) => (
            <li key={s.id} className="rounded-card border border-line bg-surface p-4 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{s.name}</p>
                  <p className="mt-0.5 text-sm text-ink-muted">
                    {reportLabel(s.report)} as {s.format === 'xlsx' ? 'Excel' : s.format.toUpperCase()} · {cadence(s)}
                  </p>
                  <p className="mt-1 text-xs text-ink-subtle">
                    To {s.recipients.map((r) => r.name).join(', ')} · next {when.format(new Date(s.next_run_at))}
                  </p>
                </div>
                <div className="flex shrink-0 items-center">
                  <IconButton label={`History of ${s.name}`} size="sm" icon={<History className="h-4 w-4" />} onClick={() => onRuns(s)} />
                  <IconButton label={`Change ${s.name}`} size="sm" icon={<Pencil className="h-4 w-4" />} onClick={() => onEdit(s)} />
                  <IconButton label={`Stop ${s.name}`} size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleting(s)} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Stop this schedule?"
        message={deleting ? `“${deleting.name}” will not be sent again. Its history is kept.` : ''}
        action="Stop schedule"
        tone="danger"
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          await remove.mutateAsync(deleting.id)
          toast({ title: 'Schedule stopped', description: `“${deleting.name}” will not be sent again.` })
          setDeleting(null)
        }}
      />
    </div>
  )
}

function ScheduleForm({ schedule, state, onDone }: { schedule: Schedule | null; state: ScreenState; onDone: () => void }) {
  const save = useSaveSchedule()
  const { toast } = useToast()
  const [name, setName] = useState(schedule?.name ?? `${reportLabel(state.report)} report`)
  const [report, setReport] = useState<ReportKind>(schedule?.report ?? state.report)
  const [format, setFormat] = useState<ReportFormat>(schedule?.format ?? 'xlsx')
  const [frequency, setFrequency] = useState<Frequency>(schedule?.frequency ?? 'weekly')
  const [dayValue, setDay] = useState<number>(schedule?.day ?? 1)
  const [hour, setHour] = useState<number>(schedule?.hour ?? 7)
  const [recipients, setRecipients] = useState<Person[]>(schedule?.recipients ?? [])
  const [query, setQuery] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const found = useRecipients(query)
  // A new schedule keeps the screen's filters; its period is always the one just ended.
  const filters: Record<string, unknown> = { ...(schedule ? schedule.filters : savedBody(state)) }
  for (const key of ['month', 'quarter', 'year', 'from', 'to']) delete filters[key]

  const days = frequency === 'weekly' ? WEEKDAYS.map((w, i) => ({ value: String(i + 1), label: w })) : Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: ordinal(i + 1) }))

  async function submit() {
    if (!name.trim()) return setProblem('Give the schedule a name.')
    if (recipients.length === 0) return setProblem('Choose at least one person to send it to.')
    const input: ScheduleInput = { name: name.trim(), report, format, frequency, day: frequency === 'daily' ? null : Math.min(dayValue, frequency === 'weekly' ? 7 : 28), hour, recipients: recipients.map((r) => r.id), filters }
    try {
      await save.mutateAsync({ id: schedule?.id ?? null, input })
      toast({ title: schedule ? 'Schedule changed' : 'Report scheduled', description: `${name.trim()}: ${cadence({ frequency, day: input.day, hour })}.` })
      onDone()
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'The schedule could not be saved. Try again.')
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <TextField label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Report" value={report} options={REPORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} onChange={(e) => setReport(e.target.value as ReportKind)} />
        <SelectField label="Format" value={format} options={FORMATS} onChange={(e) => setFormat(e.target.value as ReportFormat)} />
      </div>
      <SelectField label="How often" value={frequency} options={FREQUENCIES} onChange={(e) => setFrequency(e.target.value as Frequency)} />
      <div className="grid gap-4 sm:grid-cols-2">
        {frequency !== 'daily' && (
          <SelectField label={frequency === 'weekly' ? 'Day of the week' : 'Day of the month'} value={String(Math.min(dayValue, frequency === 'weekly' ? 7 : 28))} options={days} onChange={(e) => setDay(Number(e.target.value))} />
        )}
        <SelectField label="Time (Addis Ababa)" value={String(hour)} options={HOURS} onChange={(e) => setHour(Number(e.target.value))} />
      </div>
      <div className="space-y-2">
        <Combobox<Person>
          label="Send to"
          value={null}
          query={query}
          onQueryChange={setQuery}
          loading={found.isFetching}
          onChange={(o) => {
            if (o && !recipients.some((r) => r.id === o.value.id)) setRecipients([...recipients, o.value])
            setQuery('')
          }}
          options={(found.data ?? []).filter((p) => !recipients.some((r) => r.id === p.id)).map((p) => ({ value: { id: p.id, name: p.name }, key: p.id, label: p.name, detail: p.roles.map((r) => r.replace(/_/g, ' ')).join(', ') }))}
          hint="People in FMS who can read reports. Each is checked again when it is sent."
          emptyText="No one by that name can read reports"
        />
        {recipients.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Recipients">
            {recipients.map((r) => (
              <li key={r.id} className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-surface-muted pl-3 pr-1 text-xs font-medium text-ink">
                {r.name}
                <IconButton label={`Remove ${r.name}`} size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={() => setRecipients(recipients.filter((x) => x.id !== r.id))} className="h-6 w-6" />
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="rounded-control bg-surface-muted px-3 py-2 text-xs text-ink-muted">
        Files up to 5 MB come attached; larger ones as a link that works for 7 days. Someone who loses access to reports is skipped, and you are told.
      </p>
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          {schedule ? 'Save changes' : 'Schedule report'}
        </Button>
      </div>
    </form>
  )
}

const OUTCOME_ICON = {
  sent: <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />,
  skipped: <UserX className="h-4 w-4 text-warning" aria-hidden="true" />,
  failed: <CircleX className="h-4 w-4 text-danger" aria-hidden="true" />,
}

function RunHistory({ schedule }: { schedule: Schedule }) {
  const runs = useScheduleRuns(schedule.id)
  if (runs.isPending) return <Skeleton className="h-32" />
  if (runs.isError) return <p className="text-sm text-danger">The history could not be loaded.</p>
  if (runs.data.length === 0) return <EmptyState icon={<History />} heading="Not sent yet" description={`The first is due ${when.format(new Date(schedule.next_run_at))}.`} />
  return (
    <ol className="space-y-3" aria-label="Runs">
      {runs.data.map((r) => {
        const status = RUN_STATUS[r.status]
        const last = new Date(new Date(r.period.to).getTime() - 1)
        return (
          <li key={r.id} className="rounded-card border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">{when.format(new Date(r.due_at))}</p>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-ink-subtle">
              For {day.format(new Date(r.period.from))}
              {day.format(last) !== day.format(new Date(r.period.from)) ? ` to ${day.format(last)}` : ''}
              {r.rows !== null ? ` · ${r.rows.toLocaleString()} rows` : ''}
              {r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}
            </p>
            {r.status === 'retrying' && r.next_attempt_at && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Trying again {when.format(new Date(r.next_attempt_at))}
              </p>
            )}
            <ul className="mt-3 space-y-1.5" aria-label="Recipients">
              {r.recipients.map((o, i) => (
                <li key={o.user?.id ?? i} className="flex items-start gap-2 text-sm">
                  {OUTCOME_ICON[o.outcome]}
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{o.user?.name ?? 'Removed user'}</span>
                    <span className="text-ink-muted">
                      {' '}
                      · {o.outcome === 'sent' ? (o.delivered === 'link' ? 'sent as a link' : 'sent, attached') : o.outcome === 'skipped' ? `skipped: ${REASONS[o.reason ?? ''] ?? o.reason}` : `not sent: ${o.reason ?? 'the mail server refused it'}`}
                    </span>
                  </span>
                  {o.delivered === 'link' ? <Link2 className="h-4 w-4 text-ink-subtle" aria-hidden="true" /> : o.delivered === 'attached' ? <Paperclip className="h-4 w-4 text-ink-subtle" aria-hidden="true" /> : null}
                </li>
              ))}
            </ul>
            {r.status === 'failed' && r.error && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-danger">
                <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {r.error}
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}
