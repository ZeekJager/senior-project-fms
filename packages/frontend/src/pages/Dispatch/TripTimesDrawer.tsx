import { AlertCircle, AlertTriangle } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Button, Drawer, TextAreaField, TextField, useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useUpdateTripTimes, type TimesChange } from './api'
import { ConflictingTrip, Note } from './AssignmentPanel'
import { formatDay, formatTime, formatWindow, fromAddisInput, toAddisInput, tripTitle } from './format'
import { withoutKey } from './NewTripDrawer'
import type { ShiftedTrip, Trip } from './types'

type Field = 'start' | 'end' | 'reason'
type Errors = Partial<Record<Field, string>>

/** A 409 overlap: the other trip, and whether it can move later to make room (FMS-139). */
interface Clash {
  driver: boolean
  tripId: string
  shiftMinutes: number | null
}

interface TripTimesDrawerProps {
  open: boolean
  onClose: () => void
  trip: Trip | null
  /** A trip's name for the toast that lists the trips moved later; unknown ones are named by id. */
  titleOf: (id: string) => string | undefined
}

const MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone changed this trip a moment ago. Close the panel to see their change, then try again.',
  CONFLICT_INVALID_STATE_TRANSITION: 'This trip’s times can no longer change: it may have finished or been cancelled.',
  NOT_FOUND: 'This trip no longer exists or is outside your depots.',
}

/**
 * Move a trip's start or end after it was planned (FMS-139). Once a driver has
 * it, the change needs a reason (they see it), and a change that runs into the
 * driver's or vehicle's next trip offers to move that trip later instead of
 * refusing. A trip under way keeps its start: only its end moves.
 */
export function TripTimesDrawer({ open, onClose, trip: current, titleOf }: TripTimesDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const update = useUpdateTripTimes()
  // The trip as it was when the panel opened: its version goes in If-Match, so a change made meanwhile is caught.
  const [trip, setTrip] = useState<Trip | null>(current)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [clash, setClash] = useState<Clash | null>(null)

  useEffect(() => {
    if (!open) return
    setTrip(current)
    setStart(current?.scheduled_start ? toAddisInput(current.scheduled_start) : '')
    setEnd(current?.scheduled_end ? toAddisInput(current.scheduled_end) : '')
    setReason('')
    setErrors({})
    setFormError(null)
    setClash(null)
    update.reset()
  }, [open])

  if (!trip) return null
  const underWay = trip.status === 'en_route'
  const staffed = trip.status === 'assigned' || underWay

  function edited(field: Field, value: string) {
    if (field === 'start') setStart(value)
    else if (field === 'end') setEnd(value)
    else setReason(value)
    if (errors[field]) setErrors((current) => withoutKey(current, field))
    if (field !== 'reason') setClash(null)
  }

  function validate(t: Trip): TimesChange | null {
    const found: Errors = {}
    const s = underWay ? t.scheduled_start : fromAddisInput(start)
    const e = fromAddisInput(end)
    if (!s) found.start = 'Give a date and a time.'
    if (!e) found.end = 'Give a date and a time.'
    else if (s && e <= s) found.end = 'The end must be after the start.'
    else if (underWay && t.actual_start && e <= t.actual_start) found.end = `It started at ${formatTime(t.actual_start)}: the end must be after that.`
    // Compared as typed, to the minute: a stored time with seconds is not a change until it is edited.
    const change: TimesChange = {}
    if (!underWay && s && start !== (t.scheduled_start ? toAddisInput(t.scheduled_start) : '')) change.scheduled_start = s
    if (e && end !== (t.scheduled_end ? toAddisInput(t.scheduled_end) : '')) change.scheduled_end = e
    if (Object.keys(found).length === 0 && !change.scheduled_start && !change.scheduled_end) setFormError(underWay ? 'Change the end first.' : 'Change the start or the end first.')
    if (staffed && !reason.trim()) found.reason = 'Say why the times change: it is kept with the change.'
    setErrors(found)
    if (Object.keys(found).length > 0 || (!change.scheduled_start && !change.scheduled_end)) return null
    return reason.trim() ? { ...change, reason: reason.trim() } : change
  }

  async function save(shiftFollowing: boolean) {
    if (!trip || update.isPending) return
    setFormError(null)
    const change = validate(trip)
    if (!change) return
    try {
      const result = await update.mutateAsync({ trip, change: shiftFollowing ? { ...change, shift_following: true } : change })
      toast({ title: 'Times changed', description: describe(result.trip, result.shifted) })
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  function describe(saved: Trip, shifted: ShiftedTrip[]): string {
    const window = `${tripTitle(saved)}: ${formatWindow(saved.scheduled_start, saved.scheduled_end)}.`
    if (shifted.length === 0) return window
    const moved = shifted.map((s) => `${titleOf(s.trip_id) ?? `trip ${s.trip_id.slice(0, 8)}`} now ${formatDay(s.scheduled_start)} ${formatTime(s.scheduled_start)}`)
    return `${window} Moved later: ${moved.join('; ')}.`
  }

  function showServerError(err: unknown) {
    if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
    if (err.code === 'CONFLICT_DRIVER_OVERLAP' || err.code === 'CONFLICT_VEHICLE_OVERLAP') {
      const detail = err.details.find((d) => d.record_id)
      if (detail?.record_id) return setClash({ driver: err.code === 'CONFLICT_DRIVER_OVERLAP', tripId: detail.record_id, shiftMinutes: detail.shiftable ? (detail.shift_minutes ?? null) : null })
    }
    if (err.code === 'VALIDATION_INVALID_DATE_RANGE') return setErrors({ end: err.message })
    const found: Errors = {}
    for (const detail of err.details) {
      const field = detail.field === 'scheduled_start' ? 'start' : detail.field === 'scheduled_end' ? 'end' : detail.field === 'reason' ? 'reason' : null
      if (field && err.code.startsWith('VALIDATION')) found[field] = err.message
    }
    if (Object.keys(found).length > 0) return setErrors(found)
    setFormError(err.details.some((d) => d.reason === 'too_many_trips_to_shift') ? err.message : (MESSAGES[err.code] ?? `The times could not be changed (${err.code}).`))
  }

  const who = clash?.driver ? 'The driver' : 'The vehicle'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={underWay ? 'Change end time' : 'Change times'}
      description={`${tripTitle(trip)} · now ${formatWindow(trip.scheduled_start, trip.scheduled_end)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={update.isPending && !update.variables?.change.shift_following} disabled={clash?.shiftMinutes != null}>
            Save times
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          void save(false)
        }}
        noValidate
        className="space-y-6"
      >
        <div role="alert" className="space-y-3 empty:-mb-6">
          {formError && (
            <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
          {clash && clash.shiftMinutes !== null && (
            <Note tone="warning" icon={<AlertTriangle />} title={`${who} has another trip then`}>
              <ConflictingTrip id={clash.tripId} />
              <p className="mt-2 text-ink">
                Move it {clash.shiftMinutes} min later to make room? Any trip that then runs into it moves too, and their drivers are told.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void save(true)} loading={update.isPending}>
                  Move it {clash.shiftMinutes} min later and save
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setClash(null)} disabled={update.isPending}>
                  Choose other times
                </Button>
              </div>
            </Note>
          )}
          {clash && clash.shiftMinutes === null && (
            <Note tone="danger" icon={<AlertCircle />} title={`${who} has another trip then`}>
              <ConflictingTrip id={clash.tripId} />
              <p className="mt-2 text-ink">That trip cannot be moved for you: it starts earlier or is already under way. Choose other times.</p>
            </Note>
          )}
        </div>

        <fieldset className="space-y-1">
          <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">New times (Addis Ababa)</legend>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {underWay ? (
              <TextField label="Started" alwaysFloat value={trip.actual_start ? `${formatDay(trip.actual_start)} ${formatTime(trip.actual_start)}` : 'Under way'} readOnly hint="A trip under way keeps its start." />
            ) : (
              <TextField label="Leaves" type="datetime-local" alwaysFloat value={start} onChange={(e) => edited('start', e.target.value)} error={errors.start} />
            )}
            <TextField label={underWay ? 'Expected end' : 'Back by'} type="datetime-local" alwaysFloat value={end} onChange={(e) => edited('end', e.target.value)} error={errors.end} />
          </div>
        </fieldset>

        {staffed ? (
          <TextAreaField
            label="Reason"
            value={reason}
            onChange={(e) => edited('reason', e.target.value)}
            error={errors.reason}
            maxLength={500}
            rows={2}
            hint="Kept with the change in the trip’s history, e.g. Customer moved the delivery to 14:00."
          />
        ) : (
          <TextAreaField label="Reason" optional value={reason} onChange={(e) => edited('reason', e.target.value)} maxLength={500} rows={2} hint="Kept in the trip’s history." />
        )}
      </form>
    </Drawer>
  )
}
