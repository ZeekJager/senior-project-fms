import { AlertCircle, CheckCircle2, ChevronRight, MessageSquare, Scale, ThumbsUp, WifiOff } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge, Button, Skeleton, TextAreaField, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useAnswerFeedback, useMyFeedback, useMyFeedbackItem, type DriverFeedback } from '@/features/feedback/api'
import { MAX_REPLY, TONES, categoryLabel, subjectLabel, when } from '@/features/feedback/describe'
import { ApiError } from '@/lib/api/errors'
import { FormHeader, Note, Panel } from './parts'

// My feedback (FMS-158): what managers told the driver about a trip, a month or their driving overall. They
// acknowledge it ("Got it"), may reply once, or disagree by appealing (FMS-159). The list reads from the last copy
// with no signal.

const MY_FEEDBACK = { to: '/driver/feedback', label: 'My feedback' }

function FeedbackRow({ f }: { f: DriverFeedback }) {
  const tone = TONES[f.tone]
  return (
    <li>
      <Link to={`/driver/feedback/${f.id}`} className="focus-ring flex items-center gap-3 px-5 py-4 hover:bg-surface-muted">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={tone.tone}>{tone.label}</Badge>
            <span className="text-sm font-medium text-ink">{categoryLabel(f.category)}</span>
            {!f.acknowledged_at && <span className="text-xs font-semibold uppercase tracking-wider text-brand-ink">New</span>}
          </p>
          <p className="line-clamp-2 text-base text-ink [overflow-wrap:anywhere]">{f.message}</p>
          <p className="text-sm text-ink-muted">
            {subjectLabel(f)} · {when(f.given_at)}
          </p>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-ink-subtle" aria-hidden="true" />
      </Link>
    </li>
  )
}

/** /driver/feedback: the driver's feedback, newest first. */
export function DriverFeedbackList() {
  const mine = useMyFeedback()
  const items = mine.data?.items
  // No signal: the phone is offline, or the last try failed while a saved copy is shown.
  const offline = mine.fetchStatus === 'paused' || ((mine.isError || mine.failureCount > 0) && items !== undefined)
  return (
    <div className="space-y-5">
      <FormHeader title="My feedback" />
      {offline && items && (
        <Note tone="warning" icon={<WifiOff />}>
          No signal: this is your feedback as last saved{mine.data?.savedAt ? `, ${when(new Date(mine.data.savedAt).toISOString())}` : ''}.
        </Note>
      )}
      {!items && mine.isError ? (
        <Panel icon={<AlertCircle />} title="Your feedback could not be loaded" tone="danger">
          Check your signal and try again.
        </Panel>
      ) : !items ? (
        <Skeleton className="h-40 w-full rounded-card" />
      ) : items.length === 0 ? (
        <Panel icon={<ThumbsUp />} title="No feedback yet" tone="neutral">
          When a manager writes to you about a trip, a month or your driving, it appears here.
        </Panel>
      ) : (
        <ul aria-label="Your feedback" className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
          {items.map((f) => (
            <FeedbackRow key={f.id} f={f} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** /driver/feedback/:feedbackId: one item, Got it, a reply, I disagree. */
export function DriverFeedbackItem() {
  const { feedbackId = '' } = useParams()
  const { hasPermission } = useAuth()
  const item = useMyFeedbackItem(feedbackId)
  const answer = useAnswerFeedback(feedbackId)
  const { toast } = useToast()
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)
  const f = item.data

  async function act(run: () => Promise<unknown>, done: string) {
    setError(null)
    try {
      await run()
      toast({ title: done })
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'CONFLICT_FEEDBACK_REPLIED' ? 'You have already replied to this.' : 'It could not be sent. Check your signal and try again.')
      void item.refetch()
    }
  }

  if (!f) {
    return (
      <div className="space-y-5">
        <FormHeader title="Feedback" back={MY_FEEDBACK} />
        {item.isError ? (
          <Panel icon={<AlertCircle />} title="This feedback could not be loaded" tone="danger">
            It may have been withdrawn, or there is no signal.
          </Panel>
        ) : (
          <Skeleton className="h-64 w-full rounded-card" />
        )}
      </div>
    )
  }
  const tone = TONES[f.tone]
  const disagreeTo = `/driver/appeals/new?${new URLSearchParams({ feedback: f.id, ...(f.subject.month ? { month: f.subject.month } : {}) })}`

  return (
    <div className="space-y-5">
      <FormHeader title={categoryLabel(f.category)} back={MY_FEEDBACK} />
      <section aria-label="The feedback" className="space-y-3 rounded-card border border-line bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tone.tone}>{tone.label}</Badge>
          <span className="text-sm text-ink-muted">{subjectLabel(f)}</span>
        </div>
        <p className="whitespace-pre-line text-base text-ink [overflow-wrap:anywhere]">{f.message}</p>
        <p className="text-sm text-ink-muted">
          {f.from ? `From ${f.from.name}` : 'From your manager'} · {when(f.given_at)}
          {f.edited_at && ' · corrected'}
        </p>
      </section>

      {f.acknowledged_at ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
          You marked it as read {when(f.acknowledged_at)}.
        </p>
      ) : (
        f.can.acknowledge && (
          <Button className="w-full" size="lg" loading={answer.isPending} leadingIcon={<CheckCircle2 className="h-5 w-5" />} onClick={() => void act(() => answer.mutateAsync({ action: 'acknowledge' }), 'Marked as read')}>
            Got it
          </Button>
        )
      )}

      {f.reply && (
        <section aria-label="Your reply" className="space-y-1 rounded-card border border-line bg-surface-muted p-4">
          <p className="text-sm font-semibold text-ink">Your reply{f.replied_at ? ` · ${when(f.replied_at)}` : ''}</p>
          <p className="whitespace-pre-line text-base text-ink [overflow-wrap:anywhere]">{f.reply}</p>
        </section>
      )}

      {error && (
        <Note tone="danger" icon={<AlertCircle />}>
          {error}
        </Note>
      )}

      {f.can.reply && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!reply.trim()) return
            void act(async () => {
              await answer.mutateAsync({ action: 'reply', body: reply.trim() })
              setReply('')
            }, 'Reply sent')
          }}
        >
          <TextAreaField label="Reply (once)" hint={`Up to ${MAX_REPLY.toLocaleString()} characters.`} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={MAX_REPLY} rows={3} />
          <Button type="submit" variant="secondary" className="w-full" size="lg" disabled={!reply.trim()} loading={answer.isPending} leadingIcon={<MessageSquare className="h-5 w-5" />}>
            Send reply
          </Button>
        </form>
      )}

      {f.can.disagree && hasPermission('appeal:submit') && (
        <Link
          to={disagreeTo}
          className="focus-ring inline-flex h-12 w-full items-center justify-center gap-2 rounded-control border border-line bg-surface px-5 text-[15px] font-medium text-ink hover:bg-surface-muted"
        >
          <Scale className="h-5 w-5" aria-hidden="true" />I disagree
        </Link>
      )}
    </div>
  )
}
