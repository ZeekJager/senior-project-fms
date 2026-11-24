import { AlertCircle, CheckCircle2, Hand, MessageSquare, Paperclip, XCircle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { TripMap, type LatLng } from '@/components/TripMap'
import { Badge, Button, Drawer, SelectField, Skeleton, TextAreaField, TextField, cn, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useAppeal, useAppealStep, useOpenAttachment, type AppealDetail, type Correction } from '@/features/appeals/api'
import { CORRECTIONS, EVENT_WORDS, dueLabel, flagWord, incidentWord, reasonLabel, statusOf, targetLabel, when } from '@/features/appeals/describe'
import { ApiError } from '@/lib/api/errors'
import { monthLabel } from '@/lib/month'
import { useTrack } from '@/pages/VehicleHistory/api'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</h3>
      {children}
    </section>
  )
}

const PARTS = [
  { key: 'punctuality', label: 'On time' },
  { key: 'safety', label: 'Safe driving' },
  { key: 'incidents', label: 'No accidents' },
  { key: 'dvir', label: 'Inspections' },
] as const

/** The GPS track of the flag's trip (or around the flag or incident), with tracking:read. */
function Track({ appeal }: { appeal: AppealDetail }) {
  const { hasPermission } = useAuth()
  const canTrack = hasPermission('tracking:read')
  const t = appeal.evidence?.track ?? null
  const track = useTrack(t?.vehicle_id ?? '', t?.from ?? null, t?.to ?? null, t !== null && canTrack)
  if (!t) return <p className="text-sm text-ink-muted">No vehicle is recorded on it, so there is no GPS track.</p>
  if (!canTrack) return <p className="text-sm text-ink-muted">The GPS track needs tracking access.</p>
  if (track.isPending) return <Skeleton className="h-64 w-full rounded-card" />
  const points = track.data ?? []
  return (
    <div className="space-y-2">
      <TripMap
        label={`GPS track of ${t.registration_number}`}
        planned={{ origin: null, destination: null }}
        track={points.map((p): LatLng => [p.lat, p.lng])}
        times={points.map((p) => p.recorded_at)}
        className="h-64"
      />
      <p className="text-xs text-ink-subtle">
        <span className="plate">{t.registration_number}</span>, {when(t.from)} to {when(t.to)} · {points.length.toLocaleString()} GPS points
        {points.length > 0 && ` · top speed ${Math.max(...points.map((p) => p.speed_kmh)).toLocaleString()} km/h`}
      </p>
    </div>
  )
}

function Evidence({ appeal }: { appeal: AppealDetail }) {
  const e = appeal.evidence
  const open = useOpenAttachment(appeal.id)
  if (!e) return null
  return (
    <>
      <Section title="The driver’s evidence">
        <p className="whitespace-pre-line rounded-card border border-line bg-surface-muted p-4 text-sm text-ink">{appeal.explanation}</p>
        {appeal.attachments.length > 0 ? (
          <ul aria-label="Files" className="flex flex-wrap gap-2">
            {appeal.attachments.map((f, i) => (
              <li key={f.id}>
                <Button size="sm" variant="secondary" leadingIcon={<Paperclip className="h-3.5 w-3.5" />} loading={open.isPending && open.variables === f.id} onClick={() => open.mutate(f.id)}>
                  {f.filename ?? `File ${i + 1}`}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-subtle">No files attached.</p>
        )}
        <p className="text-xs text-ink-subtle">Each file you open is recorded on the appeal.</p>
      </Section>

      {appeal.target.type !== 'score' && (
        <Section title="GPS track">
          <Track appeal={appeal} />
        </Section>
      )}

      {e.trip_flags.length > 0 && (
        <Section title="Flags on the trip">
          <ul className="divide-y divide-line rounded-card border border-line">
            {e.trip_flags.map((f) => (
              <li key={f.id} className={cn('flex items-center justify-between gap-3 px-3 py-2 text-sm', f.id === appeal.target.id && 'bg-brand-soft')}>
                <span className="text-ink">
                  {flagWord(f.type)}
                  {f.id === appeal.target.id && <span className="ml-2 text-xs font-medium text-brand-ink">Appealed</span>}
                  {f.excluded && <span className="ml-2 text-xs text-ink-subtle">Excluded</span>}
                </span>
                <span className="tabular text-xs text-ink-muted">
                  {when(f.observed_at)}
                  {f.resolved_at ? ` to ${when(f.resolved_at)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Score, ${monthLabel(e.score.month)}`}>
        <div className="flex items-baseline gap-2">
          <span className="tabular text-3xl font-semibold text-ink">{e.score.score ?? '—'}</span>
          <span className="text-sm text-ink-muted">{e.score.score === null ? (e.score.reason === 'not_enough_trips' ? 'not enough trips for a score' : 'no score') : 'out of 100'}</span>
        </div>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PARTS.map((p) => {
            const c = e.score.components[p.key]
            return (
              <div key={p.key} className="rounded-control border border-line px-3 py-2">
                <dt className="text-xs text-ink-muted">{p.label}</dt>
                <dd className="tabular text-base font-semibold text-ink">{c?.score ?? '—'}</dd>
              </div>
            )
          })}
        </dl>
        <p className="text-xs text-ink-subtle">
          {(e.score.figures.trips_completed ?? 0).toLocaleString()} trips · {Math.round((e.score.figures.distance_m ?? 0) / 1000).toLocaleString()} km · {e.score.figures.speeding ?? 0} speeding ·{' '}
          {e.score.figures.idling ?? 0} idling · {e.score.figures.accidents ?? 0} accidents
        </p>
      </Section>
    </>
  )
}

function Timeline({ appeal }: { appeal: AppealDetail }) {
  return (
    <Section title="Timeline">
      <ol className="space-y-2">
        {appeal.timeline.map((e) => (
          <li key={e.id} className={cn('rounded-control px-3 py-2 text-sm', e.type === 'commented' ? 'border border-line bg-surface' : 'bg-surface-muted')}>
            <p className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-ink">
                {EVENT_WORDS[e.type]}
                <span className="font-normal text-ink-muted"> · {e.actor?.name ?? 'FMS'}</span>
              </span>
              <time dateTime={e.at} className="tabular text-xs text-ink-subtle">
                {when(e.at)}
              </time>
            </p>
            {e.body && e.type !== 'attachment_opened' && <p className="mt-1 whitespace-pre-line text-ink">{e.body}</p>}
          </li>
        ))}
      </ol>
    </Section>
  )
}

/**
 * One score appeal (S-36, FMS-159): the driver's case, its evidence (the GPS track of the flag, the trip's flags, the
 * month's score), the timeline, the thread, and claiming and deciding it. A decision needs a note; an approval says
 * what it takes out of the score. A reviewer may not decide against their own report.
 */
export function AppealDrawer({ appealId, onClose }: { appealId: string | null; onClose: () => void }) {
  const appeal = useAppeal(appealId)
  const step = useAppealStep(appealId ?? '')
  const { toast } = useToast()
  const [comment, setComment] = useState('')
  const [outcome, setOutcome] = useState<'approved' | 'rejected' | ''>('')
  const [correction, setCorrection] = useState<Correction | ''>('')
  const [itemId, setItemId] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setComment('')
    setOutcome('')
    setCorrection('')
    setItemId('')
    setNote('')
    setError(null)
  }, [appealId])

  if (!appealId) return null
  const a = appeal.data

  async function run(fn: () => Promise<unknown>, done: string) {
    setError(null)
    try {
      await fn()
      toast({ title: done })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null
      setError(
        code === 'CONFLICT_OWN_REPORT'
          ? 'You reported or reviewed what this appeal is against. Another reviewer must decide it.'
          : code === 'CONFLICT_INVALID_STATE_TRANSITION'
            ? 'Someone moved it on a moment ago. The latest is shown.'
            : err instanceof ApiError && err.status === 400
              ? err.message
              : 'It could not be saved. Check your connection and try again.',
      )
      void appeal.refetch()
    }
  }

  const decide = () => {
    if (!outcome) return setError('Choose Approve or Reject.')
    if (!note.trim()) return setError('Write a decision note: the driver reads it.')
    if (outcome === 'approved' && a?.kind === 'appeal' && !correction) return setError('Choose what the approval takes out of the score.')
    if (outcome === 'approved' && a?.target.type === 'score' && correction && !itemId.trim()) return setError('Give the flag, incident or trip id the correction takes out.')
    void run(
      () =>
        step.mutateAsync({
          action: 'decision',
          outcome,
          note: note.trim(),
          ...(outcome === 'approved' && correction ? { correction } : {}),
          ...(outcome === 'approved' && a?.target.type === 'score' && itemId.trim() ? { item_id: itemId.trim() } : {}),
        }),
      outcome === 'approved' ? 'Appeal approved' : 'Appeal rejected',
    )
  }

  const s = a ? statusOf(a) : null
  const due = a ? dueLabel(a) : null

  return (
    <Drawer
      open
      onClose={onClose}
      title={a ? `${a.driver.name}: ${targetLabel(a, a.evidence?.flag?.type ?? a.evidence?.incident?.type)}` : 'Appeal'}
      description={a ? `${a.kind === 'complaint' ? 'Complaint' : 'Appeal'} · ${reasonLabel(a.reason)} · sent ${when(a.submitted_at)}${a.depot ? ` · ${a.depot.name}` : ''}` : undefined}
      footer={
        a?.can.claim ? (
          <div className="flex justify-end">
            <Button loading={step.isPending} leadingIcon={<Hand className="h-4 w-4" />} onClick={() => void run(() => step.mutateAsync({ action: 'claim' }), 'Claimed: it is under review')}>
              Claim for review
            </Button>
          </div>
        ) : a?.can.decide ? (
          <div className="flex justify-end">
            <Button loading={step.isPending} variant={outcome === 'rejected' ? 'danger' : 'primary'} onClick={decide}>
              {outcome === 'rejected' ? 'Reject' : outcome === 'approved' ? 'Approve' : 'Decide'}
            </Button>
          </div>
        ) : undefined
      }
    >
      {!a ? (
        appeal.isError ? (
          <p className="flex items-center gap-2 text-sm text-danger">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            This appeal could not be loaded.
          </p>
        ) : (
          <Skeleton className="h-96 w-full rounded-card" />
        )
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            {s && <Badge tone={s.tone}>{s.label}</Badge>}
            {due && <Badge tone={a.overdue ? 'danger' : 'neutral'}>{due}</Badge>}
            {a.escalated_at && <Badge tone="danger">Sent to the depot admin</Badge>}
          </div>

          <dl>
            {a.evidence?.flag && <Fact label="Flag">{`${flagWord(a.evidence.flag.type)}, ${when(a.evidence.flag.observed_at)}${a.evidence.flag.resolved_at ? ` to ${when(a.evidence.flag.resolved_at)}` : ''}`}</Fact>}
            {a.evidence?.incident && <Fact label="Incident">{`${incidentWord(a.evidence.incident.type)}, ${when(a.evidence.incident.occurred_at)}`}</Fact>}
            {a.claimed_by && <Fact label="Claimed by">{`${a.claimed_by.name}${a.claimed_at ? `, ${when(a.claimed_at)}` : ''}`}</Fact>}
            {a.decided_by && <Fact label="Decided by">{`${a.decided_by.name}${a.decided_at ? `, ${when(a.decided_at)}` : ''}`}</Fact>}
            {a.decision_note && <Fact label="Decision note">{a.decision_note}</Fact>}
            {a.correction && <Fact label="Correction">{`${CORRECTIONS[a.correction].label}${a.score_before !== null ? ` · score ${a.score_before} to ${a.score_after}` : ''}`}</Fact>}
          </dl>

          <Evidence appeal={a} />
          <Timeline appeal={a} />

          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-control border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          {a.can.comment && (
            <Section title="Ask the driver">
              <TextAreaField label="Message" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={2000} hint="The driver is told by push." />
              <Button
                variant="secondary"
                size="sm"
                disabled={!comment.trim()}
                loading={step.isPending}
                leadingIcon={<MessageSquare className="h-3.5 w-3.5" />}
                onClick={() =>
                  void run(async () => {
                    await step.mutateAsync({ action: 'comment', body: comment.trim() })
                    setComment('')
                  }, 'Sent to the driver')
                }
              >
                Send
              </Button>
            </Section>
          )}

          {a.can.decide && (
            <Section title="Decision">
              <div role="radiogroup" aria-label="Outcome" className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['approved', 'Approve', <CheckCircle2 key="a" className="h-4 w-4 text-success" />],
                    ['rejected', 'Reject', <XCircle key="r" className="h-4 w-4 text-danger" />],
                  ] as const
                ).map(([value, label, icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={outcome === value}
                    onClick={() => setOutcome(value)}
                    className={cn('focus-ring flex items-center justify-center gap-2 rounded-control border px-3 py-2 text-sm font-medium', outcome === value ? 'border-brand bg-brand-soft text-ink' : 'border-line text-ink-muted')}
                  >
                    {icon}
                    {label}
                  </button>
                ))}
              </div>
              {outcome === 'approved' && (
                <>
                  <SelectField
                    label={a.kind === 'complaint' ? 'Correct the score (optional)' : 'What it takes out of the score'}
                    value={correction}
                    onChange={(e) => setCorrection(e.target.value as Correction)}
                    placeholder="Choose"
                    options={(a.evidence?.corrections ?? []).map((c) => ({ value: c, label: CORRECTIONS[c].label }))}
                    hint={correction ? CORRECTIONS[correction].detail : 'The original data is kept; it no longer counts.'}
                  />
                  {a.target.type === 'score' && correction && (
                    <TextField label={correction === 'exclude_trip' ? 'Trip id' : correction === 'exclude_flag' ? 'Flag id' : 'Incident id'} value={itemId} onChange={(e) => setItemId(e.target.value)} hint="From the driver’s month: what the correction takes out." />
                  )}
                </>
              )}
              <TextAreaField label="Decision note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} hint="Required. The driver reads it." />
            </Section>
          )}
        </div>
      )}
    </Drawer>
  )
}
