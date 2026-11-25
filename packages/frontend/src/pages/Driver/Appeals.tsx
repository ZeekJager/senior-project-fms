import { AlertCircle, Camera, CheckCircle2, ChevronRight, FileText, MessageSquare, Paperclip, Scale, Send, Undo2, X } from 'lucide-react'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Badge, Button, SelectField, Skeleton, TextAreaField, cn, useToast } from '@/components/ui'
import {
  useAppeal,
  useAppealStep,
  useAppealable,
  useMyAppeals,
  useOpenAttachment,
  useSubmitAppeal,
  type Appeal,
  type AppealDetail,
  type AppealReason,
} from '@/features/appeals/api'
import {
  CORRECTIONS,
  EVENT_WORDS,
  FILE_TYPES,
  MAX_EXPLANATION,
  MAX_FILE_BYTES,
  MAX_FILES,
  MIN_EXPLANATION,
  REASONS,
  flagWord,
  incidentWord,
  reasonLabel,
  statusOf,
  targetLabel,
  when,
} from '@/features/appeals/describe'
import { ApiError } from '@/lib/api/errors'
import { monthLabel } from '@/lib/month'
import { FormHeader, Note, Panel } from './parts'

// My appeals (FMS-159): a driver appeals or complains about a flag, an incident or a month's score with photos or
// files, follows it to a decision, answers the reviewer's questions, and acknowledges what was decided.

const MY_APPEALS = { to: '/driver/appeals', label: 'My appeals' }

function AppealRow({ a }: { a: Appeal }) {
  const s = statusOf(a)
  return (
    <li>
      <Link to={`/driver/appeals/${a.id}`} className="focus-ring flex items-center gap-3 px-5 py-4 hover:bg-surface-muted">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-base font-semibold text-ink">{targetLabel(a)}</p>
          <p className="text-sm text-ink-muted">
            {a.kind === 'complaint' ? 'Complaint' : 'Appeal'} · sent {when(a.submitted_at)}
          </p>
        </div>
        <Badge tone={s.tone}>{s.label}</Badge>
        <ChevronRight className="h-5 w-5 shrink-0 text-ink-subtle" aria-hidden="true" />
      </Link>
    </li>
  )
}

/** /driver/appeals: the driver's appeals, newest first, and the way to a new one. */
export function DriverAppeals() {
  const mine = useMyAppeals()
  const items = mine.data?.data
  return (
    <div className="space-y-5">
      <FormHeader title="My appeals" />
      <Link
        to="/driver/appeals/new"
        className="focus-ring inline-flex h-12 w-full items-center justify-center gap-2 rounded-control bg-brand px-5 text-[15px] font-medium text-white shadow-soft hover:bg-brand-strong"
      >
        <Scale className="h-5 w-5" aria-hidden="true" />
        Appeal or complain
      </Link>
      {!items && mine.isError ? (
        <Panel icon={<AlertCircle />} title="Your appeals could not be loaded" tone="danger">
          Check your signal and try again.
        </Panel>
      ) : !items ? (
        <Skeleton className="h-40 w-full rounded-card" />
      ) : items.length === 0 ? (
        <Panel icon={<Scale />} title="No appeals yet" tone="neutral">
          If a flag, an incident or your score looks wrong, appeal it within 30 days.
        </Panel>
      ) : (
        <ul aria-label="Your appeals" className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
          {items.map((a) => (
            <AppealRow key={a.id} a={a} />
          ))}
        </ul>
      )}
    </div>
  )
}

function FilesList({ appeal }: { appeal: Appeal }) {
  const open = useOpenAttachment(appeal.id)
  if (appeal.attachments.length === 0) return null
  return (
    <ul aria-label="Your files" className="flex flex-wrap gap-2">
      {appeal.attachments.map((f, i) => (
        <li key={f.id}>
          <Button variant="secondary" size="sm" loading={open.isPending && open.variables === f.id} onClick={() => open.mutate(f.id)} leadingIcon={<Paperclip className="h-4 w-4" />}>
            {f.filename ?? `File ${i + 1}`}
          </Button>
        </li>
      ))}
    </ul>
  )
}

function Timeline({ appeal }: { appeal: AppealDetail }) {
  return (
    <ol aria-label="What happened" className="space-y-3">
      {appeal.timeline.map((e) => (
        <li key={e.id} className={cn('rounded-card border border-line px-4 py-3', e.type === 'commented' ? 'bg-surface' : 'bg-surface-muted')}>
          <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-semibold text-ink">
              {EVENT_WORDS[e.type]}
              {e.actor ? <span className="font-normal text-ink-muted"> · {e.actor.name}</span> : null}
            </span>
            <time dateTime={e.at} className="tabular text-xs text-ink-subtle">
              {when(e.at)}
            </time>
          </p>
          {e.body && <p className="mt-1.5 whitespace-pre-line text-base text-ink">{e.body}</p>}
        </li>
      ))}
    </ol>
  )
}

/** /driver/appeals/:appealId: one appeal, its decision and its thread. */
export function DriverAppeal() {
  const { appealId = '' } = useParams()
  const appeal = useAppeal(appealId)
  const step = useAppealStep(appealId)
  const { toast } = useToast()
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)
  const a = appeal.data

  async function act(run: () => Promise<unknown>, done: string) {
    setError(null)
    try {
      await run()
      toast({ title: done })
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'CONFLICT_INVALID_STATE_TRANSITION' ? 'It has moved on meanwhile. The latest is shown.' : 'It could not be sent. Check your signal and try again.')
      void appeal.refetch()
    }
  }

  if (!a) {
    return (
      <div className="space-y-5">
        <FormHeader title="Appeal" back={MY_APPEALS} />
        {appeal.isError ? (
          <Panel icon={<AlertCircle />} title="This appeal could not be loaded" tone="danger">
            It may not be yours, or there is no signal.
          </Panel>
        ) : (
          <Skeleton className="h-64 w-full rounded-card" />
        )}
      </div>
    )
  }
  const s = statusOf(a)
  const decided = a.outcome === 'approved' || a.outcome === 'rejected'

  return (
    <div className="space-y-5">
      <FormHeader title={targetLabel(a)} back={MY_APPEALS} />
      <section aria-label="Your appeal" className="space-y-3 rounded-card border border-line bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={s.tone}>{s.label}</Badge>
          <span className="text-sm text-ink-muted">
            {a.kind === 'complaint' ? 'Complaint' : 'Appeal'} · {reasonLabel(a.reason)}
          </span>
        </div>
        <p className="whitespace-pre-line text-base text-ink">{a.explanation}</p>
        <FilesList appeal={a} />
      </section>

      {decided && (
        <section
          aria-label="The decision"
          className={cn('space-y-2 rounded-card border p-5', a.outcome === 'approved' ? 'border-success/30 bg-success-soft' : 'border-danger/25 bg-danger-soft')}
        >
          <p className="flex items-center gap-2 text-base font-semibold text-ink">
            {a.outcome === 'approved' ? <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" /> : <X className="h-5 w-5 text-danger" aria-hidden="true" />}
            {a.outcome === 'approved' ? 'Approved' : 'Not approved'}
            {a.decided_at && <span className="text-sm font-normal text-ink-muted">· {when(a.decided_at)}</span>}
          </p>
          {a.decision_note && <p className="whitespace-pre-line text-base text-ink">{a.decision_note}</p>}
          {a.correction && (
            <p className="text-sm text-ink-muted">
              {CORRECTIONS[a.correction].detail}
              {a.score_before !== null && a.score_after !== null && a.score_before !== a.score_after && (
                <>
                  {' '}
                  Your score: <span className="tabular font-semibold text-ink">{a.score_before}</span> to <span className="tabular font-semibold text-ink">{a.score_after}</span>.
                </>
              )}
            </p>
          )}
          {a.can.acknowledge && (
            <Button className="mt-2 w-full" size="lg" loading={step.isPending} onClick={() => void act(() => step.mutateAsync({ action: 'acknowledge' }), 'Marked as read')}>
              I have read the decision
            </Button>
          )}
        </section>
      )}

      <section aria-labelledby="thread-heading" className="space-y-3">
        <h2 id="thread-heading" className="text-sm font-semibold uppercase tracking-wider text-ink-subtle">
          What happened
        </h2>
        <Timeline appeal={a} />
      </section>

      {error && (
        <Note tone="danger" icon={<AlertCircle />}>
          {error}
        </Note>
      )}

      {a.can.comment && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!reply.trim()) return
            void act(async () => {
              await step.mutateAsync({ action: 'comment', body: reply.trim() })
              setReply('')
            }, 'Sent to the reviewer')
          }}
        >
          <TextAreaField label="Write to the reviewer" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={2000} rows={3} />
          <Button type="submit" variant="secondary" className="w-full" size="lg" disabled={!reply.trim()} loading={step.isPending} leadingIcon={<MessageSquare className="h-5 w-5" />}>
            Send
          </Button>
        </form>
      )}

      {a.can.withdraw && (
        <Button variant="ghost" className="w-full" leadingIcon={<Undo2 className="h-4 w-4" />} loading={step.isPending} onClick={() => void act(() => step.mutateAsync({ action: 'withdraw' }), 'Appeal withdrawn')}>
          Withdraw this appeal
        </Button>
      )}
    </div>
  )
}

type Choice = { type: 'flag' | 'incident'; id: string } | { type: 'score'; month: string }

/** /driver/appeals/new: what it is against, why, and photos or files. Needs signal: the files go with it. */
export function DriverNewAppeal() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const appealable = useAppealable()
  const submit = useSubmitAppeal()
  const { toast } = useToast()
  const camera = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  // "I disagree" on feedback (FMS-158) opens this form with the feedback, and its month when it was about one.
  const feedbackId = params.get('feedback')
  const preset = params.get('month') ? `score:${params.get('month')}` : params.get('flag') ? `flag:${params.get('flag')}` : params.get('incident') ? `incident:${params.get('incident')}` : ''
  const [target, setTarget] = useState(preset)
  const [kind, setKind] = useState<'appeal' | 'complaint'>('appeal')
  const [reason, setReason] = useState<AppealReason | ''>('')
  const [explanation, setExplanation] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(false)

  const choices = useMemo(() => {
    const d = appealable.data
    if (!d) return [] as { value: string; label: string; disabled: boolean; choice: Choice }[]
    return [
      ...d.months.map((m) => ({ value: `score:${m}`, label: `My score for ${monthLabel(m)}`, disabled: false, choice: { type: 'score', month: m } as Choice })),
      ...d.items.map((i) => ({
        value: `${i.target_type}:${i.id}`,
        label: `${i.target_type === 'flag' ? flagWord(i.kind) : incidentWord(i.kind)}, ${when(i.at)}${i.open_appeal_id ? ' (already appealed)' : i.excluded ? ' (already excluded)' : ''}`,
        disabled: i.open_appeal_id !== null || i.excluded,
        choice: { type: i.target_type, id: i.id } as Choice,
      })),
    ]
  }, [appealable.data])
  const chosen = choices.find((c) => c.value === target)

  const explanationError = tried && explanation.trim().length < MIN_EXPLANATION ? `Say what happened in at least ${MIN_EXPLANATION} characters.` : null

  function addFiles(list: FileList | null) {
    if (!list) return
    setError(null)
    const next = [...files]
    for (const f of Array.from(list)) {
      if (next.length >= MAX_FILES) {
        setError(`At most ${MAX_FILES} files.`)
        break
      }
      if (!FILE_TYPES.includes(f.type)) {
        setError(`${f.name}: photos (JPEG, PNG, WebP) or PDF only.`)
        continue
      }
      if (f.size > MAX_FILE_BYTES) {
        setError(`${f.name} is over 5 MB.`)
        continue
      }
      next.push(f)
    }
    setFiles(next)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setTried(true)
    if (!chosen || !reason || explanation.trim().length < MIN_EXPLANATION) return
    setError(null)
    try {
      const c = chosen.choice
      const sent = await submit.mutateAsync({
        kind,
        target_type: c.type,
        ...(c.type === 'score' ? { month: c.month } : { target_id: c.id }),
        reason,
        explanation: explanation.trim(),
        ...(feedbackId ? { feedback_id: feedbackId } : {}),
        files,
      })
      toast({ title: 'Appeal sent', description: 'A reviewer at your depot will look at it.' })
      navigate(`/driver/appeals/${sent.id}`, { replace: true })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null
      setError(
        code === 'CONFLICT_APPEAL_OPEN'
          ? 'You already have an open appeal against this. Follow it in My appeals.'
          : code === 'CONFLICT_APPEAL_WINDOW_CLOSED'
            ? err instanceof ApiError
              ? err.message
              : ''
            : code === 'UNSUPPORTED_MEDIA_TYPE' || code === 'PAYLOAD_TOO_LARGE'
              ? 'One of the files was refused: photos or PDF, 5 MB each at most.'
              : 'It could not be sent. Check your signal and try again: nothing was lost.',
      )
    }
  }

  return (
    <form className="space-y-5" onSubmit={(e) => void onSubmit(e)} noValidate>
      <FormHeader title="Appeal or complain" back={feedbackId ? { to: `/driver/feedback/${feedbackId}`, label: 'The feedback' } : MY_APPEALS} />
      {feedbackId && (
        <p className="rounded-control border border-line bg-surface-muted px-3.5 py-3 text-base text-ink-muted">
          You disagree with feedback from your manager. Choose what it is about below; the manager who gave it will not decide your appeal.
        </p>
      )}
      {appealable.isError ? (
        <Panel icon={<AlertCircle />} title="What you can appeal could not be loaded" tone="danger">
          Check your signal and try again.
        </Panel>
      ) : !appealable.data ? (
        <Skeleton className="h-40 w-full rounded-card" />
      ) : choices.length === 0 ? (
        <Panel icon={<Scale />} title="Nothing to appeal" tone="neutral">
          Flags, incidents and month scores can be appealed within {appealable.data.window_days} days.
        </Panel>
      ) : (
        <>
          <fieldset className="grid grid-cols-2 gap-2" aria-label="Appeal or complaint">
            {(['appeal', 'complaint'] as const).map((k) => (
              <label
                key={k}
                className={cn(
                  'focus-within:ring-brand/40 flex cursor-pointer flex-col rounded-card border px-4 py-3 focus-within:ring-2',
                  kind === k ? 'border-brand bg-brand-soft' : 'border-line bg-surface',
                )}
              >
                <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
                <span className="text-base font-semibold text-ink">{k === 'appeal' ? 'Appeal' : 'Complaint'}</span>
                <span className="text-sm text-ink-muted">{k === 'appeal' ? 'It is wrong: correct my score.' : 'Something was unfair.'}</span>
              </label>
            ))}
          </fieldset>
          <SelectField
            label="What is it about?"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Choose"
            options={choices.filter((c) => !c.disabled || c.value === target).map((c) => ({ value: c.value, label: c.label }))}
            error={tried && !chosen ? 'Choose what you are appealing.' : null}
          />
          <SelectField
            label="Why?"
            value={reason}
            onChange={(e) => setReason(e.target.value as AppealReason)}
            placeholder="Choose a reason"
            options={REASONS}
            error={tried && !reason ? 'Choose a reason.' : null}
          />
          <TextAreaField
            label="What happened"
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            rows={5}
            maxLength={MAX_EXPLANATION}
            error={explanationError}
            hint={`${explanation.trim().length} of at least ${MIN_EXPLANATION} characters`}
          />

          <section aria-label="Photos and files" className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="secondary" size="lg" disabled={files.length >= MAX_FILES} onClick={() => camera.current?.click()} leadingIcon={<Camera className="h-5 w-5" />}>
                Take a photo
              </Button>
              <Button type="button" variant="secondary" size="lg" disabled={files.length >= MAX_FILES} onClick={() => picker.current?.click()} leadingIcon={<FileText className="h-5 w-5" />}>
                Add a file
              </Button>
            </div>
            <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take a photo" onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }} />
            <input ref={picker} type="file" multiple accept={FILE_TYPES.join(',')} className="sr-only" aria-label="Add photos or files" onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }} />
            <p className="text-sm text-ink-muted">Up to {MAX_FILES} photos or PDF files, 5 MB each.</p>
            {files.length > 0 && (
              <ul aria-label="Attached" className="space-y-2">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-control border border-line bg-surface px-3 py-2">
                    <Paperclip className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{f.name}</span>
                    <span className="tabular text-xs text-ink-subtle">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                    <button type="button" className="focus-ring rounded-control p-1 text-ink-muted hover:text-ink" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, k) => k !== i))}>
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {error && (
            <Note tone="danger" icon={<AlertCircle />}>
              {error}
            </Note>
          )}
          <Button type="submit" size="lg" className="w-full" loading={submit.isPending} leadingIcon={<Send className="h-5 w-5" />}>
            Send
          </Button>
          <p className="text-center text-xs text-ink-subtle">A reviewer at your depot decides within 5 working days. You can withdraw it until then.</p>
        </>
      )}
    </form>
  )
}

