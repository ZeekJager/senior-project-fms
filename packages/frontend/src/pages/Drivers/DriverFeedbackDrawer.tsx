import { AlertTriangle, BookmarkPlus, CheckCircle2, History, MessageSquarePlus, MessageSquareText, Pencil, Undo2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { EmptyState, ErrorState } from '@/components/shared'
import { Badge, Button, Drawer, SelectField, Skeleton, TextAreaField, TextField, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import {
  PAGE_SIZE,
  useChangeFeedback,
  useCompletedTrips,
  useDriverFeedback,
  useFeedbackCategories,
  useFeedbackTemplates,
  useGiveFeedback,
  useRemoveTemplate,
  useSaveTemplate,
  type Feedback,
  type FeedbackSubject,
  type FeedbackTone,
} from '@/features/feedback/api'
import { CATEGORIES, MAX_MESSAGE, MIN_MESSAGE, TONES, categoryLabel, subjectLabel, when } from '@/features/feedback/describe'
import { ApiError } from '@/lib/api/errors'
import { monthLabel } from '@/lib/month'

/** What the drawer opens with: the driver, and a subject to give feedback on (from a trip, or a month's report). */
export interface FeedbackTarget {
  driverId: string
  name: string
  give?: { subject: FeedbackSubject; tripId?: string; month?: string }
}

/**
 * A driver's feedback (FMS-158), for their managers: newest first, filtered by category and tone, with the counts
 * per category of the last 90 days and the items unread for a week flagged. feedback:write gives, corrects (the
 * author, for 24 hours) and retracts; templates fill the message.
 */
export function DriverFeedbackDrawer({ target, onClose }: { target: FeedbackTarget | null; onClose: () => void }) {
  if (!target) return null
  return <FeedbackOf key={target.driverId} target={target} onClose={onClose} />
}

function FeedbackOf({ target, onClose }: { target: FeedbackTarget; onClose: () => void }) {
  const { hasPermission } = useAuth()
  const canWrite = hasPermission('feedback:write')
  const [category, setCategory] = useState('')
  const [tone, setTone] = useState('')
  const [page, setPage] = useState(1)
  const [giving, setGiving] = useState(canWrite && target.give !== undefined)
  const list = useDriverFeedback(target.driverId, { category, tone, page })
  const items = list.data?.items ?? []
  const counts = list.data?.counts
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE))

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Feedback: ${target.name}`}
      description="What managers told this driver, newest first"
      className="sm:!max-w-[640px]"
      footer={
        pages > 1 ? (
          <div className="flex w-full items-center justify-between gap-3">
            <p className="tabular text-xs text-ink-subtle">
              Page {page} of {pages}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                Newer
              </Button>
              <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Older
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {giving ? (
          <GiveForm target={target} onDone={() => setGiving(false)} />
        ) : (
          canWrite && (
            <Button leadingIcon={<MessageSquarePlus className="h-4 w-4" />} onClick={() => setGiving(true)}>
              Give feedback
            </Button>
          )
        )}

        {counts && (
          <section aria-label="The last 90 days" className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">Last {counts.days} days</h3>
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(counts.by_category).length === 0 ? (
                <span className="text-sm text-ink-muted">No feedback in the last {counts.days} days.</span>
              ) : (
                Object.entries(counts.by_category).map(([c, n]) => (
                  <Badge key={c} tone="neutral">
                    {categoryLabel(c)} <span className="tabular">{n}</span>
                  </Badge>
                ))
              )}
            </div>
            {counts.unacknowledged_overdue > 0 && (
              <p className="flex items-center gap-1.5 text-sm text-warning">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                {counts.unacknowledged_overdue === 1 ? '1 item' : `${counts.unacknowledged_overdue} items`} not read after 7 days
              </p>
            )}
          </section>
        )}

        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Category"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value)
              setPage(1)
            }}
            options={[{ value: '', label: 'All categories' }, ...CATEGORIES]}
          />
          <SelectField
            label="Tone"
            value={tone}
            onChange={(e) => {
              setTone(e.target.value)
              setPage(1)
            }}
            options={[{ value: '', label: 'All tones' }, ...Object.entries(TONES).map(([value, t]) => ({ value, label: t.label }))]}
          />
        </div>

        {list.isError && !list.data ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<MessageSquareText />} heading="No feedback" description={category || tone ? 'None matches these filters.' : 'Feedback given to this driver appears here.'} />
        ) : (
          <ul className="space-y-2" aria-label={`Feedback to ${target.name}`}>
            {items.map((f) => (
              <FeedbackItem key={f.id} f={f} driverId={target.driverId} />
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  )
}

function FeedbackItem({ f, driverId }: { f: Feedback; driverId: string }) {
  const change = useChangeFeedback(driverId)
  const { toast } = useToast()
  const [mode, setMode] = useState<'view' | 'edit' | 'retract'>('view')
  const [text, setText] = useState(f.message)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const t = TONES[f.tone]

  async function run(kind: 'edit' | 'retract') {
    setError(null)
    try {
      await change.mutateAsync({ id: f.id, change: kind === 'edit' ? { action: 'edit', message: text.trim() } : { action: 'retract', reason: reason.trim() } })
      toast({ title: kind === 'edit' ? 'Feedback corrected' : 'Feedback retracted' })
      setMode('view')
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'CONFLICT_FEEDBACK_LOCKED'
          ? 'More than 24 hours have passed: it can only be retracted now.'
          : err instanceof ApiError && err.code === 'CONFLICT_FEEDBACK_RETRACTED'
            ? 'It was retracted meanwhile.'
            : 'It could not be saved. Try again.',
      )
    }
  }

  return (
    <li className={`space-y-2 rounded-control border border-line bg-surface p-3.5 ${f.retracted_at ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={t.tone}>{t.label}</Badge>
        <span className="text-sm font-medium text-ink">{categoryLabel(f.category)}</span>
        <span className="text-sm text-ink-muted">· {subjectLabel(f)}</span>
        {f.retracted_at && <Badge tone="neutral">Retracted</Badge>}
        {f.unacknowledged_overdue && (
          <Badge tone="warning" dot>
            Not read after 7 days
          </Badge>
        )}
      </div>
      {mode === 'edit' ? (
        <TextAreaField label="Message" value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_MESSAGE} rows={4} />
      ) : (
        <p className="whitespace-pre-line text-sm text-ink [overflow-wrap:anywhere]">{f.message}</p>
      )}
      <p className="text-xs text-ink-subtle">
        {f.from?.name ?? 'Unknown'} · {when(f.given_at)}
        {f.edited_at && ` · corrected ${when(f.edited_at)}`}
      </p>
      {f.retracted_at && (
        <p className="text-xs text-ink-muted">
          Retracted {when(f.retracted_at)}
          {f.retracted_by ? ` by ${f.retracted_by.name}` : ''}: {f.retraction_reason}
        </p>
      )}
      {(f.acknowledged_at || f.reply) && (
        <div className="space-y-1 rounded-control bg-surface-muted px-3 py-2 text-sm">
          {f.acknowledged_at && (
            <p className="flex items-center gap-1.5 text-ink-muted">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              Read by the driver {when(f.acknowledged_at)}
            </p>
          )}
          {f.reply && (
            <p className="text-ink [overflow-wrap:anywhere]">
              <span className="font-medium">Reply{f.replied_at ? ` (${when(f.replied_at)})` : ''}:</span> {f.reply}
            </p>
          )}
        </div>
      )}
      {f.revisions.length > 0 && (
        <details className="text-xs text-ink-muted">
          <summary className="focus-ring inline-flex cursor-pointer items-center gap-1 rounded-control">
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            {f.revisions.length === 1 ? 'Earlier text' : `${f.revisions.length} earlier texts`}
          </summary>
          <ul className="mt-1.5 space-y-1.5">
            {f.revisions.map((r) => (
              <li key={r.at} className="whitespace-pre-line border-l-2 border-line pl-2 [overflow-wrap:anywhere]">
                {r.message}
                <span className="block text-ink-subtle">Replaced {when(r.at)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {mode === 'retract' && <TextField label="Why it is retracted" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
      {error && <p className="text-sm text-danger">{error}</p>}
      {mode === 'view' ? (
        (f.can.edit || f.can.retract) && (
          <div className="flex gap-2">
            {f.can.edit && (
              <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setMode('edit')}>
                Correct
              </Button>
            )}
            {f.can.retract && (
              <Button size="sm" variant="ghost" leadingIcon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => setMode('retract')}>
                Retract
              </Button>
            )}
          </div>
        )
      ) : (
        <div className="flex gap-2">
          <Button
            size="sm"
            loading={change.isPending}
            disabled={mode === 'edit' ? text.trim().length < MIN_MESSAGE : !reason.trim()}
            onClick={() => void run(mode)}
          >
            {mode === 'edit' ? 'Save correction' : 'Retract'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode('view')}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  )
}

const SUBJECTS: { value: FeedbackSubject; label: string }[] = [
  { value: 'trip', label: 'A trip' },
  { value: 'month', label: 'A month' },
  { value: 'overall', label: 'Overall performance' },
]

/** The months a manager may give feedback on: this one and the 11 before, newest first. */
function recentMonths(now = new Date()): string[] {
  const out: string[] = []
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  for (let i = 0; i < 12; i++) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
    d.setUTCMonth(d.getUTCMonth() - 1)
  }
  return out
}

function GiveForm({ target, onDone }: { target: FeedbackTarget; onDone: () => void }) {
  const give = useGiveFeedback(target.driverId)
  const categories = useFeedbackCategories()
  const templates = useFeedbackTemplates(true)
  const saveTemplate = useSaveTemplate()
  const removeTemplate = useRemoveTemplate()
  const { toast } = useToast()
  const [subject, setSubject] = useState<FeedbackSubject>(target.give?.subject ?? 'overall')
  const [tripId, setTripId] = useState(target.give?.tripId ?? '')
  const [month, setMonth] = useState(target.give?.month ?? recentMonths()[0])
  const [category, setCategory] = useState('')
  const [tone, setTone] = useState<FeedbackTone | ''>('')
  const [message, setMessage] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [templateTitle, setTemplateTitle] = useState('')
  const [tried, setTried] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trips = useCompletedTrips(target.driverId, subject === 'trip')

  const inUse = useMemo(() => CATEGORIES.filter((c) => (categories.data ?? CATEGORIES.map((x) => x.value)).includes(c.value)), [categories.data])
  const forCategory = (templates.data ?? []).filter((t) => !category || t.category === category)
  const tripOptions = useMemo(() => {
    const options = (trips.data ?? []).map((t) => ({ value: t.id, label: `${t.route_name ?? 'Trip'} · ${t.actual_end ? when(t.actual_end) : t.scheduled_start ? when(t.scheduled_start) : ''}` }))
    // A trip opened from elsewhere may be older than the 20 listed.
    if (tripId && !options.some((o) => o.value === tripId)) options.unshift({ value: tripId, label: 'The trip you came from' })
    return options
  }, [trips.data, tripId])

  const messageError = tried && message.trim().length < MIN_MESSAGE ? `Write at least ${MIN_MESSAGE} characters.` : null
  const ready = category && tone && message.trim().length >= MIN_MESSAGE && (subject !== 'trip' || tripId)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setTried(true)
    if (!ready || !tone) return
    setError(null)
    try {
      await give.mutateAsync({
        subject_type: subject,
        ...(subject === 'trip' ? { trip_id: tripId } : {}),
        ...(subject === 'month' ? { month } : {}),
        category,
        tone,
        message: message.trim(),
      })
      toast({ title: 'Feedback sent', description: `${target.name} is told in the app and by push.` })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? 'This driver is not in your depot.' : err instanceof ApiError && err.status === 400 ? 'Check the fields: something was not accepted.' : 'It could not be sent. Try again.')
    }
  }

  async function saveAsTemplate() {
    if (!category || message.trim().length < MIN_MESSAGE || !templateTitle.trim()) return
    try {
      await saveTemplate.mutateAsync({ category, title: templateTitle.trim(), body: message.trim() })
      setTemplateTitle('')
      toast({ title: 'Template saved' })
    } catch {
      toast({ title: 'The template could not be saved', tone: 'danger' })
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-3 rounded-card border border-line bg-surface-muted p-4" aria-label="Give feedback">
      <div className="grid grid-cols-2 gap-3">
        <SelectField label="About" value={subject} onChange={(e) => setSubject(e.target.value as FeedbackSubject)} options={SUBJECTS} />
        {subject === 'trip' && (
          <SelectField label="Trip" value={tripId} onChange={(e) => setTripId(e.target.value)} options={tripOptions} placeholder={trips.isPending ? 'Loading trips…' : 'Choose a completed trip'} error={tried && !tripId ? 'Choose a trip.' : null} />
        )}
        {subject === 'month' && <SelectField label="Month" value={month} onChange={(e) => setMonth(e.target.value)} options={recentMonths().map((m) => ({ value: m, label: monthLabel(m) }))} />}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value)} options={inUse} placeholder="Choose" error={tried && !category ? 'Choose a category.' : null} />
        <SelectField
          label="Tone"
          value={tone}
          onChange={(e) => setTone(e.target.value as FeedbackTone)}
          options={Object.entries(TONES).map(([value, t]) => ({ value, label: t.label }))}
          placeholder="Choose"
          error={tried && !tone ? 'Choose a tone.' : null}
        />
      </div>
      {forCategory.length > 0 && (
        <div className="flex items-end gap-2">
          <SelectField
            className="flex-1"
            label="Start from a template"
            value={templateId}
            onChange={(e) => {
              const t = forCategory.find((x) => x.id === e.target.value)
              setTemplateId(e.target.value)
              if (t) {
                setMessage(t.body)
                if (!category) setCategory(t.category)
              }
            }}
            options={forCategory.map((t) => ({ value: t.id, label: `${t.title} (${categoryLabel(t.category)})` }))}
            placeholder="None"
          />
          {templateId && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                void removeTemplate.mutateAsync(templateId).then(() => {
                  setTemplateId('')
                  toast({ title: 'Template removed' })
                })
              }
            >
              Remove template
            </Button>
          )}
        </div>
      )}
      <TextAreaField label="Message" hint={`${MIN_MESSAGE} to ${MAX_MESSAGE.toLocaleString()} characters. The driver reads it in the app.`} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={MAX_MESSAGE} rows={4} error={messageError} />
      <div className="flex items-end gap-2">
        <TextField className="flex-1" label="Template name (optional)" value={templateTitle} onChange={(e) => setTemplateTitle(e.target.value)} maxLength={80} />
        <Button type="button" size="sm" variant="secondary" leadingIcon={<BookmarkPlus className="h-3.5 w-3.5" />} disabled={!category || message.trim().length < MIN_MESSAGE || !templateTitle.trim()} loading={saveTemplate.isPending} onClick={() => void saveAsTemplate()}>
          Save as template
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={give.isPending}>
          Send feedback
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
