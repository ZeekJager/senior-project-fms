import { CircleSlash, Hourglass, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Button, TextAreaField } from '@/components/ui'
import { ApiError, type ApiErrorDetail } from '@/lib/api/errors'
import { ConflictingTrip, Note } from './AssignmentPanel'
import { useDecideException } from './api'
import { formatDay, formatTime } from './format'
import type { AssignmentException, AssignmentWarning, Trip } from './types'

// Approved exceptions to the assignment rules (FMS-151, docs/assignment-exceptions.md): a warning the depot holds is
// sent to a fleet manager with the dispatcher's reason; the trip waits, and shows it, until they approve or refuse.

const ATTENDANCE: Record<string, string> = { driver_absent: 'absent', driver_on_leave: 'on leave', driver_sick: 'sick' }

/** One held warning, as the 409 names it or as the request keeps it. */
function HeldWarning({ reason, recordId, driverName }: { reason: string; recordId?: string; driverName: string }) {
  if (ATTENDANCE[reason]) return <li>{driverName} is marked {ATTENDANCE[reason]} that day.</li>
  return (
    <li>
      A trip still under way runs into this one{recordId ? ':' : '.'}
      {recordId && <ConflictingTrip id={recordId} />}
    </li>
  )
}

const asDetail = (w: AssignmentWarning): ApiErrorDetail =>
  w.warning === 'DRIVER_ATTENDANCE' ? { field: w.field, reason: `driver_${w.attendance}` } : { field: w.field, reason: 'previous_trip_overrun', record_id: w.trip_id }

/**
 * The assignment raised a warning the depot holds (409 CONFLICT_APPROVAL_REQUIRED): what it is, and a reason to send
 * with the request. The safety rules never come here: they refuse.
 */
export function AskApproval({ error, driverName, busy, onAsk }: { error: ApiError; driverName: string; busy: boolean; onAsk: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  const [missing, setMissing] = useState(false)
  return (
    <Note tone="warning" icon={<ShieldAlert />} title="Needs a fleet manager’s approval">
      <ul className="mt-1 space-y-1 text-ink">
        {error.details.map((d, i) => (
          <HeldWarning key={i} reason={d.reason ?? ''} recordId={d.record_id} driverName={driverName} />
        ))}
      </ul>
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!reason.trim()) return setMissing(true)
          onAsk(reason.trim())
        }}
      >
        <TextAreaField
          label="Why this assignment"
          value={reason}
          maxLength={500}
          onChange={(e) => {
            setReason(e.target.value)
            setMissing(false)
          }}
          error={missing ? 'Say why, for the fleet manager.' : undefined}
          hint="The fleet manager reads this before deciding. The trip stays unassigned until then."
        />
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" loading={busy}>
            Ask for approval
          </Button>
        </div>
      </form>
    </Note>
  )
}

const when = (iso: string) => `${formatDay(iso)} at ${formatTime(iso)}`

interface AwaitingProps {
  trip: Trip
  exception: AssignmentException
  driverName: string
  plate: string
  /** assignment-exception:approve, and not the one who asked. */
  canDecide: boolean
  /** The viewer asked: someone else decides. */
  ownRequest: boolean
}

/** A request waiting for a fleet manager: what is asked and why; for one who may decide, Approve and Refuse. */
export function AwaitingApproval({ trip, exception, driverName, plate, canDecide, ownRequest }: AwaitingProps) {
  const decide = useDecideException()
  const [text, setText] = useState('')
  const [missing, setMissing] = useState(false)
  const failure = decide.error
  return (
    <Note tone="warning" icon={<Hourglass />} title="Awaiting a fleet manager’s approval">
      <p className="mt-1 text-ink">
        {driverName} with {plate}, asked by {exception.requested_by_name ?? 'a dispatcher'} {when(exception.requested_at)}.
      </p>
      <ul className="mt-1 space-y-1 text-ink">
        {exception.warnings.map((w, i) => {
          const d = asDetail(w)
          return <HeldWarning key={i} reason={d.reason ?? ''} recordId={d.record_id} driverName={driverName} />
        })}
      </ul>
      <p className="mt-2 text-ink">
        <span className="font-medium">Reason:</span> {exception.reason}
      </p>
      {ownRequest && <p className="mt-2 text-xs">Another fleet manager decides on a request you made.</p>}
      {canDecide && (
        <div className="mt-3 space-y-3">
          <TextAreaField
            label="Note, or why you refuse"
            value={text}
            maxLength={500}
            onChange={(e) => {
              setText(e.target.value)
              setMissing(false)
            }}
            error={missing ? 'Say why you refuse it: the dispatcher is told.' : undefined}
            hint="Approving assigns the trip now, after every rule is checked again."
          />
          {failure != null && (
            <p className="text-sm text-danger" role="alert">
              {failure instanceof ApiError ? failure.message : 'Could not reach the server. Try again.'}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              leadingIcon={<CircleSlash className="h-4 w-4" />}
              loading={decide.isPending && decide.variables?.decision === 'refuse'}
              disabled={decide.isPending}
              onClick={() => {
                if (!text.trim()) return setMissing(true)
                decide.mutate({ trip, exception, decision: 'refuse', text: text.trim() })
              }}
            >
              Refuse
            </Button>
            <Button
              loading={decide.isPending && decide.variables?.decision === 'approve'}
              disabled={decide.isPending}
              onClick={() => decide.mutate({ trip, exception, decision: 'approve', text: text.trim() || undefined })}
            >
              Approve and assign
            </Button>
          </div>
        </div>
      )}
    </Note>
  )
}

/** The last request was refused: why, so the dispatcher chooses again. */
export function RefusedNote({ exception }: { exception: AssignmentException }) {
  return (
    <Note tone="danger" icon={<CircleSlash />} title="Approval refused">
      <p className="mt-1 text-ink">
        {exception.decided_by_name ?? 'A fleet manager'} refused it{exception.decided_at ? ` ${when(exception.decided_at)}` : ''}: {exception.decision_reason}
      </p>
      <p className="mt-0.5 text-xs">Choose another driver or vehicle, or ask again with a new reason.</p>
    </Note>
  )
}
