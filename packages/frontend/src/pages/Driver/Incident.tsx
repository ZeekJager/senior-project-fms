import {
  AlertCircle,
  AlertTriangle,
  CarFront,
  CheckCircle2,
  CircleEllipsis,
  CloudUpload,
  Construction,
  Disc,
  Hammer,
  HeartPulse,
  LocateFixed,
  MapPin,
  MapPinOff,
  Send,
  ShieldAlert,
  Truck,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Skeleton, Spinner, TextAreaField, cn } from '@/components/ui'
import { QUEUE_FULL_MESSAGE, QueueFullError } from '@/lib/offlineQueue'
import { useOfflineQueue } from '@/pwa/OfflineQueue'
import { useTripVehicle, useWorkingTrip, type WorkingTrip } from './api'
import {
  checkIncident,
  EMPTY_INCIDENT,
  INCIDENT_TYPES,
  incidentBody,
  MAX_DESCRIPTION,
  SEVERITIES,
  severityLabel,
  type IncidentDraft,
  type IncidentErrors,
  type IncidentType,
  type Position,
  type Severity,
} from './incidentReport'
import { FormHeader, Note, Panel, VehicleCard } from './parts'

const TYPE_ICONS: Record<IncidentType, LucideIcon> = {
  accident: CarFront,
  breakdown: Wrench,
  tyre: Disc,
  theft: ShieldAlert,
  vandalism: Hammer,
  injury: HeartPulse,
  road_hazard: Construction,
  other: CircleEllipsis,
}

type Done = { status: 'sent' | 'queued'; severity: Severity; withVehicle: boolean }

/**
 * Incident report (FMS-38, S-13): what happened, how serious, in the driver's
 * words, and where if they allow it. It is about the vehicle of their trip
 * when they have one, and still goes without one: an incident is reported
 * from wherever the driver is. Submits through the offline queue (FMS-81):
 * with no signal it waits on the phone, stamped with when it was reported.
 */
export function DriverIncident() {
  const [params] = useSearchParams()
  const working = useWorkingTrip(params.get('trip'))
  const [done, setDone] = useState<Done | null>(null)

  return (
    <div className="space-y-5">
      <FormHeader title="Report an incident" />
      {done ? <Result done={done} onAnother={() => setDone(null)} /> : <IncidentForm working={working} onDone={setDone} />}
    </div>
  )
}

type Locating = { state: 'idle' } | { state: 'locating' } | { state: 'failed'; message: string }

function IncidentForm({ working, onDone }: { working: { trip: WorkingTrip | null; loading: boolean }; onDone: (done: Done) => void }) {
  const { submit, full, online } = useOfflineQueue()
  const trip = working.trip?.vehicleId ? (working.trip as WorkingTrip & { vehicleId: string }) : null
  const vehicle = useTripVehicle(trip?.vehicleId ?? null)
  const [draft, setDraft] = useState<IncidentDraft>(EMPTY_INCIDENT)
  const [checked, setChecked] = useState(false)
  // Once the driver has tried to send, the messages follow what they do.
  const errors: IncidentErrors = checked ? checkIncident(draft) : {}
  const [locating, setLocating] = useState<Locating>({ state: 'idle' })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // From the current draft, not this render's: the location arrives while the driver may still be typing.
  function change(next: Partial<IncidentDraft>) {
    setDraft((current) => ({ ...current, ...next }))
    setError(null)
  }

  function locate() {
    if (!('geolocation' in navigator)) {
      setLocating({ state: 'failed', message: 'This phone cannot share its location.' })
      return
    }
    setLocating({ state: 'locating' })
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLocating({ state: 'idle' })
        change({ location: { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy } })
      },
      (err) =>
        setLocating({
          state: 'failed',
          message: err.code === err.PERMISSION_DENIED ? 'Location is blocked for this app. Say where it happened instead.' : 'The location could not be found. Say where it happened instead.',
        }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    )
  }

  async function send() {
    setChecked(true)
    if (Object.keys(checkIncident(draft)).length > 0) return
    setSending(true)
    setError(null)
    try {
      const plate = vehicle.data?.registration_number
      const result = await submit({
        kind: 'incident',
        label: `Incident, ${severityLabel(draft.severity!)}${trip ? `, ${plate ?? trip.routeName ?? 'your vehicle'}` : ''}`,
        path: '/incidents',
        body: incidentBody(draft, trip ? { tripId: trip.id, vehicleId: trip.vehicleId } : null, new Date()),
      })
      if (result.status === 'rejected') {
        setError(`It was not accepted: ${result.rejection.message}`)
        return
      }
      onDone({ status: result.status, severity: draft.severity!, withVehicle: trip !== null })
    } catch (err) {
      setError(err instanceof QueueFullError ? err.message : 'It could not be saved on this phone. Try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      {working.loading ? (
        <Skeleton className="h-16 w-full rounded-card" />
      ) : trip ? (
        <VehicleCard trip={trip} />
      ) : (
        <div className="flex items-center gap-3 rounded-card border border-dashed border-line-strong px-4 py-3 text-ink-muted">
          <Truck className="h-6 w-6 shrink-0" aria-hidden="true" />
          <span className="text-sm">No trip under way: the report goes to your depot without a vehicle.</span>
        </div>
      )}

      <fieldset className="space-y-3">
        <legend className="mb-3 text-base font-semibold text-ink">
          What happened? <span className="font-normal text-ink-muted">(optional)</span>
        </legend>
        <div className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-4">
          {INCIDENT_TYPES.map(({ value, label }) => {
            const Icon = TYPE_ICONS[value]
            return (
              <Option key={value} name="incident-type" checked={draft.type === value} onChange={() => change({ type: value })} className="h-20 flex-col gap-1.5 text-sm">
                <Icon className="h-6 w-6" aria-hidden="true" />
                {label}
              </Option>
            )
          })}
        </div>
      </fieldset>

      <fieldset aria-describedby={errors.severity ? 'severity-error' : undefined}>
        <legend className="mb-3 text-base font-semibold text-ink">How serious is it?</legend>
        <div className="space-y-2">
          {SEVERITIES.map(({ value, label, text }) => (
            <Option
              key={value}
              name="severity"
              checked={draft.severity === value}
              onChange={() => change({ severity: value })}
              tone={value === 'critical' ? 'danger' : 'brand'}
              className="justify-start gap-3 px-4 py-3 text-left"
            >
              <span className={cn('h-3 w-3 shrink-0 rounded-full', DOT[value])} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-base font-semibold">{label}</span>
                <span className="block text-sm font-normal text-ink-muted">{text}</span>
              </span>
            </Option>
          ))}
        </div>
        {errors.severity && (
          <p id="severity-error" className="mt-2 text-sm font-medium text-danger">
            {errors.severity}
          </p>
        )}
        {draft.severity === 'critical' && (
          <div className="mt-3">
            <Note tone="warning" icon={<AlertTriangle />}>
              {trip
                ? 'Dispatch is alerted at once and the vehicle is flagged for a maintenance check. Do not drive it until dispatch says so.'
                : 'Dispatch is alerted at once.'}{' '}
              If someone is hurt, call emergency services first.
            </Note>
          </div>
        )}
      </fieldset>

      <TextAreaField
        label="What happened"
        rows={4}
        value={draft.description}
        onChange={(e) => change({ description: e.target.value })}
        error={errors.description}
        hint={`Where, what you saw, anyone hurt. ${draft.description.length.toLocaleString('en')} / ${MAX_DESCRIPTION.toLocaleString('en')}`}
        maxLength={MAX_DESCRIPTION}
      />

      <LocationField location={draft.location} locating={locating} onLocate={locate} onClear={() => change({ location: null })} />

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
          disabled={sending || full}
          aria-busy={sending}
          className="focus-ring flex h-16 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-lg font-bold text-white shadow-soft transition hover:bg-brand-strong active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {online ? <Send className="h-5 w-5" aria-hidden="true" /> : <CloudUpload className="h-5 w-5" aria-hidden="true" />}
          {sending ? 'Sending…' : online ? 'Send report' : 'Save report'}
        </button>
        <p className="text-center text-sm text-ink-muted">{online ? 'Dispatch sees it right away.' : 'No signal: it is kept on this phone and sent when there is signal.'}</p>
      </div>
    </form>
  )
}

const DOT: Record<Severity, string> = { low: 'bg-ink-subtle', medium: 'bg-info', high: 'bg-warning', critical: 'bg-danger' }

/** A large radio as a tappable card: native input (arrow keys, the fieldset's legend), styled by its state. */
function Option({
  name,
  checked,
  onChange,
  tone = 'brand',
  className,
  children,
}: {
  name: string
  checked: boolean
  onChange: () => void
  tone?: 'brand' | 'danger'
  className?: string
  children: ReactNode
}) {
  return (
    <label
      className={cn(
        'flex min-h-12 cursor-pointer items-center justify-center rounded-xl border font-medium transition-colors has-[:focus-visible]:shadow-focus',
        !checked && 'border-line-strong bg-surface text-ink hover:bg-surface-muted',
        checked && tone === 'brand' && 'border-brand bg-brand-soft text-brand-ink ring-1 ring-inset ring-brand',
        checked && tone === 'danger' && 'border-danger bg-danger-soft text-danger ring-1 ring-inset ring-danger',
        className,
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      {children}
    </label>
  )
}

function LocationField({ location, locating, onLocate, onClear }: { location: Position | null; locating: Locating; onLocate: () => void; onClear: () => void }) {
  if (location) {
    return (
      <div className="flex items-center gap-3 rounded-card border border-success/40 bg-surface px-4 py-3 shadow-soft">
        <MapPin className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-sm text-ink">
          <span className="block font-semibold">Location added</span>
          <span className="block text-ink-muted">Within about {Math.max(1, Math.round(location.accuracy))} m</span>
        </span>
        <button type="button" onClick={onClear} aria-label="Remove location" className="focus-ring flex h-10 w-10 items-center justify-center rounded-full text-ink-muted hover:bg-surface-muted">
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onLocate}
        disabled={locating.state === 'locating'}
        className="focus-ring flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface text-base font-semibold text-ink shadow-soft hover:bg-surface-muted disabled:opacity-70"
      >
        {locating.state === 'locating' ? <Spinner className="h-5 w-5" /> : <LocateFixed className="h-5 w-5 text-brand-ink" aria-hidden="true" />}
        {locating.state === 'locating' ? 'Finding your location…' : 'Add my location'}
        <span className="font-normal text-ink-muted">(optional)</span>
      </button>
      {locating.state === 'failed' && (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <MapPinOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          {locating.message}
        </p>
      )}
    </div>
  )
}

function Result({ done, onAnother }: { done: Done; onAnother: () => void }) {
  const sent = done.status === 'sent'
  const critical = done.severity === 'critical'
  return (
    <div className="space-y-4">
      <Panel icon={sent ? <CheckCircle2 /> : <CloudUpload />} title={sent ? 'Report sent' : 'Saved on this phone'} tone={sent ? 'success' : 'neutral'}>
        {sent
          ? critical
            ? 'Dispatch has been alerted.'
            : 'Dispatch has your report.'
          : 'It is sent as soon as the phone has signal, with the time you reported it. Until then it shows in the badge at the top.'}
      </Panel>
      {critical && done.withVehicle && (
        <Note tone="warning" icon={<AlertTriangle />}>
          Do not drive the vehicle until dispatch says so.
        </Note>
      )}
      <Link to="/driver" className="focus-ring flex h-14 w-full items-center justify-center rounded-2xl bg-brand text-lg font-semibold text-white shadow-soft hover:bg-brand-strong">
        Back to My day
      </Link>
      <button type="button" onClick={onAnother} className="focus-ring flex h-12 w-full items-center justify-center rounded-2xl text-base font-medium text-ink-muted hover:bg-surface">
        Report another incident
      </button>
    </div>
  )
}
