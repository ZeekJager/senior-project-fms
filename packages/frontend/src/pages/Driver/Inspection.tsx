import { AlertCircle, AlertTriangle, Check, CheckCircle2, CloudUpload } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { cn } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { QUEUE_FULL_MESSAGE, QueueFullError } from '@/lib/offlineQueue'
import { useOfflineQueue } from '@/pwa/OfflineQueue'
import { useTripVehicle, useWorkingTrip, type WorkingTrip } from './api'
import { FormHeader, Note, Panel, TripGate, VehicleCard } from './parts'
import { CHECKLISTS, INSPECTION_NAMES, inspectionBody, readPostTrip, writePostTrip, type Answer, type InspectionType } from './checklist'

type Done = { status: 'sent' | 'queued'; type: InspectionType; defects: number }

const typeParam = (value: string | null): InspectionType | null => (value === 'pre_trip' || value === 'post_trip' ? value : null)

/**
 * The vehicle inspection (FMS-37, S-12): the pre- or post-trip checklist
 * for the vehicle of the driver's trip, one answer per item, and what is
 * wrong for any problem. Submitting goes through the offline queue
 * (FMS-81): with no signal the report waits on the phone and is sent, once,
 * when the signal returns.
 */
export function DriverInspection() {
  const [params] = useSearchParams()
  const tripId = params.get('trip')
  const working = useWorkingTrip(tripId)
  const [done, setDone] = useState<Done | null>(null)

  return (
    <div className="space-y-5">
      <FormHeader title="Vehicle inspection" />
      {done ? (
        <Result done={done} />
      ) : (
        <TripGate
          state={working}
          tripId={tripId}
          noTrip={{ title: 'No vehicle to inspect', text: 'Inspections are for the vehicle of your trip. When dispatch assigns one, it shows here.' }}
        >
          {(trip) => (
            <InspectionForm
              key={`${trip.id}:${params.get('type') ?? ''}`}
              trip={trip}
              initialType={typeParam(params.get('type')) ?? (trip.status === 'assigned' ? 'pre_trip' : 'post_trip')}
              onDone={setDone}
            />
          )}
        </TripGate>
      )}
    </div>
  )
}

function InspectionForm({ trip, initialType, onDone }: { trip: WorkingTrip & { vehicleId: string }; initialType: InspectionType; onDone: (done: Done) => void }) {
  const { session } = useAuth()
  const { submit, full, online } = useOfflineQueue()
  const vehicle = useTripVehicle(trip.vehicleId)
  const [type, setType] = useState<InspectionType>(initialType)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const items = CHECKLISTS[type]
  const left = items.filter((name) => !answers[name]).length
  const defects = items.filter((name) => answers[name]?.passed === false).length
  const plate = vehicle.data?.registration_number ?? null

  function answer(name: string, value: Answer) {
    setAnswers((current) => ({ ...current, [name]: value }))
    setError(null)
  }

  async function send() {
    setSending(true)
    setError(null)
    try {
      const result = await submit({
        kind: 'dvir',
        label: `${INSPECTION_NAMES[type]}, ${plate ?? trip.routeName ?? 'your vehicle'}`,
        path: '/dvir-reports',
        body: inspectionBody({ vehicleId: trip.vehicleId, tripId: trip.id, type, answers }),
      })
      if (result.status === 'rejected') {
        setError(`It was not accepted: ${result.rejection.message}`)
        return
      }
      // The post-trip reminder on My day is done with.
      if (type === 'post_trip' && readPostTrip(session?.user.id ?? '')?.tripId === trip.id) writePostTrip(null)
      onDone({ status: result.status, type, defects })
    } catch (err) {
      setError(err instanceof QueueFullError ? err.message : 'It could not be saved on this phone. Try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <VehicleCard trip={trip} />

      <fieldset>
        <legend className="sr-only">Inspection</legend>
        <div className="grid grid-cols-2 gap-1 rounded-2xl bg-surface-sunken p-1">
          {(['pre_trip', 'post_trip'] as const).map((t) => (
            <label
              key={t}
              className={cn(
                'flex h-12 cursor-pointer items-center justify-center rounded-xl text-base font-semibold transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand',
                type === t ? 'bg-surface text-ink shadow-soft' : 'text-ink-muted',
              )}
            >
              <input
                type="radio"
                name="inspection-type"
                value={t}
                checked={type === t}
                onChange={() => {
                  setType(t)
                  setAnswers({})
                  setError(null)
                }}
                className="sr-only"
              />
              {t === 'pre_trip' ? 'Pre-trip' : 'Post-trip'}
            </label>
          ))}
        </div>
      </fieldset>

      <section aria-labelledby="checklist-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="checklist-heading" className="text-sm font-semibold uppercase tracking-wider text-ink-subtle">
            Check each item
          </h2>
          <p className="text-sm tabular-nums text-ink-muted" aria-live="polite">
            {left === 0 ? 'All checked' : `${left} of ${items.length} to check`}
          </p>
        </div>
        <ol className="space-y-3">
          {items.map((name) => (
            <ChecklistItem key={name} name={name} answer={answers[name]} onAnswer={(value) => answer(name, value)} />
          ))}
        </ol>
      </section>

      {defects > 0 && (
        <Note tone="warning" icon={<AlertTriangle />}>
          {defects === 1 ? '1 problem' : `${defects} problems`} reported: the vehicle will be flagged for maintenance. {type === 'pre_trip' ? 'Do not drive it until dispatch says so.' : 'A technician will look at it.'}
        </Note>
      )}

      <div className="space-y-3">
        <div role="alert" className="empty:hidden">
          {error && (
            <Note tone="danger" icon={<AlertCircle />}>
              {error}
            </Note>
          )}
        </div>
        {full && !error && (
          <Note tone="danger" icon={<AlertCircle />}>
            {QUEUE_FULL_MESSAGE}
          </Note>
        )}
        <button
          type="submit"
          disabled={left > 0 || sending || full}
          aria-busy={sending}
          className="focus-ring flex h-16 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-lg font-bold text-white shadow-soft transition hover:bg-brand-strong active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {online ? <Check className="h-5 w-5" aria-hidden="true" /> : <CloudUpload className="h-5 w-5" aria-hidden="true" />}
          {sending ? 'Sending…' : online ? 'Submit inspection' : 'Save inspection'}
        </button>
        <p className="text-center text-sm text-ink-muted">
          {left > 0 ? 'Answer every item to submit.' : online ? 'Sent to maintenance now.' : 'No signal: it is kept on this phone and sent when there is signal.'}
        </p>
      </div>
    </form>
  )
}

function ChecklistItem({ name, answer, onAnswer }: { name: string; answer: Answer | undefined; onAnswer: (value: Answer) => void }) {
  const notesId = useId()
  const problem = answer?.passed === false
  return (
    <li className={cn('rounded-card border bg-surface p-4 shadow-soft', problem ? 'border-warning/50' : answer ? 'border-success/40' : 'border-line')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-lg font-medium text-ink">{name}</span>
        <div role="radiogroup" aria-label={name} className="grid w-full grid-cols-2 gap-2 min-[400px]:w-auto">
          <Choice checked={answer?.passed === true} tone="ok" onSelect={() => onAnswer({ passed: true })}>
            <Check className="h-5 w-5" aria-hidden="true" />
            OK
          </Choice>
          <Choice checked={problem} tone="problem" onSelect={() => onAnswer({ passed: false, notes: problem ? answer.notes : '' })}>
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            Problem
          </Choice>
        </div>
      </div>
      {problem && (
        <div className="mt-3">
          <label htmlFor={notesId} className="mb-1.5 block text-sm font-medium text-ink">
            What is wrong? <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <textarea
            id={notesId}
            rows={2}
            maxLength={1000}
            value={answer.notes}
            onChange={(e) => onAnswer({ passed: false, notes: e.target.value })}
            placeholder="For example: front left tyre worn, slow leak"
            className="focus-ring block w-full rounded-control border border-line-strong bg-surface px-3 py-2.5 text-base text-ink placeholder:text-ink-subtle"
          />
        </div>
      )}
    </li>
  )
}

function Choice({ checked, tone, onSelect, children }: { checked: boolean; tone: 'ok' | 'problem'; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'focus-ring flex h-12 min-w-[7rem] items-center justify-center gap-1.5 rounded-xl border text-base font-semibold transition-colors',
        !checked && 'border-line-strong bg-surface text-ink-muted hover:bg-surface-muted',
        checked && tone === 'ok' && 'border-transparent bg-success-solid text-white',
        checked && tone === 'problem' && 'border-transparent bg-warning-soft text-warning ring-2 ring-inset ring-warning/60',
      )}
    >
      {children}
    </button>
  )
}

function Result({ done }: { done: Done }) {
  const sent = done.status === 'sent'
  return (
    <div className="space-y-4">
      <Panel icon={sent ? <CheckCircle2 /> : <CloudUpload />} title={sent ? 'Inspection sent' : 'Saved on this phone'} tone={sent ? 'success' : 'neutral'}>
        {sent
          ? done.defects > 0
            ? `Maintenance has the ${done.defects === 1 ? 'problem' : `${done.defects} problems`} you reported, and the vehicle is flagged.`
            : 'Maintenance has your inspection. Nothing to fix.'
          : 'It is sent as soon as the phone has signal. Until then it shows in the badge at the top.'}
      </Panel>
      {done.defects > 0 && done.type === 'pre_trip' && (
        <Note tone="warning" icon={<AlertTriangle />}>
          Do not drive the vehicle until dispatch says so.
        </Note>
      )}
      <Link to="/driver" className="focus-ring flex h-14 w-full items-center justify-center rounded-2xl bg-brand text-lg font-semibold text-white shadow-soft hover:bg-brand-strong">
        Back to My day
      </Link>
    </div>
  )
}
