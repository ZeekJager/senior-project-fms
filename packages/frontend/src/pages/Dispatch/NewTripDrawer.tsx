import { AlertCircle, MapPinned, Route as RouteIcon } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, cn, Drawer, SelectField, TextField, useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { parseCoordinates } from '@/pages/Routes/routeForm'
import { useCreateTrip, useDepotRoutes, type NewTrip } from './api'
import { formatDuration, formatTime, fromAddisInput, nextQuarterHour, toAddisInput, tripTitle } from './format'
import type { Trip } from './types'

type Mode = 'route' | 'adhoc'

interface Values {
  mode: Mode
  route_id: string
  origin_name: string
  origin: string
  destination_name: string
  destination: string
  start: string
  end: string
}

type Field = Exclude<keyof Values, 'mode'>
type Errors = Partial<Record<Field, string>>

interface NewTripDrawerProps {
  open: boolean
  onClose: () => void
  /** The depot the console shows: saved routes are its own, and a one-off trip leaves from it. */
  depot: { id: string; name: string }
  onCreated: (trip: Trip) => void
}

const COORDINATES_HINT = 'Latitude, longitude: paste from a map, e.g. 9.0054, 38.7636.'

const MODES: { value: Mode; label: string; icon: ReactNode }[] = [
  { value: 'route', label: 'Saved route', icon: <RouteIcon /> },
  { value: 'adhoc', label: 'One-off trip', icon: <MapPinned /> },
]

/** A request field to the form's (one-off route fields come back as route.origin_name and so on). */
function formField(field: string | undefined): Field | null {
  if (!field) return null
  if (field === 'scheduled_start') return 'start'
  if (field === 'scheduled_end') return 'end'
  const name = field.replace(/^route\./, '').replace(/\.(latitude|longitude)$/, '')
  return (['route_id', 'origin_name', 'origin', 'destination_name', 'destination'] as const).find((f) => f === name) ?? null
}

/**
 * Create a trip from the console (FMS-139): from one of the depot's saved
 * routes, or a one-off trip nobody planned, from a place to a place. Times are
 * Addis Ababa; a saved route's estimated time fills in the end.
 */
export function NewTripDrawer({ open, onClose, depot, onCreated }: NewTripDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const routes = useDepotRoutes(depot.id, open)
  const create = useCreateTrip()
  const [values, setValues] = useState<Values>(() => blank())
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setValues(blank())
    setErrors({})
    setFormError(null)
    create.reset()
  }, [open])

  const route = routes.data?.find((r) => r.id === values.route_id) ?? null
  const estimate = values.mode === 'route' ? (route?.estimated_duration_seconds ?? null) : null
  const startIso = fromAddisInput(values.start)

  function set(field: Field, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    if (errors[field]) setErrors((current) => withoutKey(current, field))
  }

  function validate(): NewTrip | null {
    const found: Errors = {}
    const start = fromAddisInput(values.start)
    if (!start) found.start = 'Give the date and time it leaves.'
    const end = values.end ? fromAddisInput(values.end) : null
    if (values.end && !end) found.end = 'Give a date and a time.'
    else if (end && start && end <= start) found.end = 'The end must be after the start.'
    else if (!values.end && estimate === null) found.end = values.mode === 'adhoc' ? 'Give an end time: a one-off trip has no estimate.' : 'Give an end time: the route has no estimated time.'

    let input: NewTrip | null = null
    if (values.mode === 'route') {
      if (!values.route_id) found.route_id = 'Choose a route.'
      else if (start) input = { route_id: values.route_id, scheduled_start: start, ...(end ? { scheduled_end: end } : {}) }
    } else {
      if (!values.origin_name.trim()) found.origin_name = 'Where does it leave from?'
      if (!values.destination_name.trim()) found.destination_name = 'Where does it go?'
      const origin = parseCoordinates(values.origin)
      const destination = parseCoordinates(values.destination)
      if (!origin.ok) found.origin = origin.error
      if (!destination.ok) found.destination = destination.error
      if (start && origin.ok && destination.ok) {
        input = {
          route: { origin_name: values.origin_name.trim(), origin: origin.value, destination_name: values.destination_name.trim(), destination: destination.value },
          depot_id: depot.id,
          scheduled_start: start,
          ...(end ? { scheduled_end: end } : {}),
        }
      }
    }
    setErrors(found)
    return Object.keys(found).length === 0 ? input : null
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (create.isPending) return
    setFormError(null)
    const input = validate()
    if (!input) return
    try {
      const trip = await create.mutateAsync(input)
      toast({ title: 'Trip created', description: `${tripTitle(trip)} is ready to assign.` })
      onCreated(trip)
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  function showServerError(err: unknown) {
    if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
    if (err.code === 'VALIDATION_INVALID_DATE_RANGE') return setErrors({ end: 'The end must be after the start.' })
    const found: Errors = {}
    for (const detail of err.details) {
      const field = formField(detail.field)
      if (field) found[field] = detail.reason === 'references_missing_record' ? 'That route is no longer available. Choose another.' : (err.details.length === 1 ? err.message : 'Check this value.')
    }
    if (Object.keys(found).length > 0) return setErrors(found)
    setFormError(err.details.some((d) => d.field === 'depot_id') ? `Trips cannot be created for ${depot.name}.` : `The trip could not be created (${err.code}).`)
  }

  const endHint =
    estimate !== null && startIso
      ? `Blank: ${formatTime(new Date(new Date(startIso).getTime() + estimate * 1000).toISOString())}, after the route’s estimated ${formatDuration(estimate)}.`
      : values.mode === 'route'
        ? 'Needed when the route has no estimated time.'
        : 'When the vehicle should be back for its next trip.'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New trip"
      description={`Leaves from ${depot.name}. Assign a driver and vehicle once it is created.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            Create trip
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-6">
        <div role="alert" className="empty:-mb-6">
          {formError && (
            <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
        </div>

        <fieldset>
          <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Where it goes</legend>
          <div className="grid grid-cols-2 gap-1 rounded-control bg-surface-sunken p-1">
            {MODES.map((m) => (
              <label
                key={m.value}
                className={cn(
                  'flex cursor-pointer items-center justify-center gap-2 rounded-control px-3 py-2 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand coarse:min-h-11 [&_svg]:h-4 [&_svg]:w-4',
                  values.mode === m.value ? 'bg-surface text-ink shadow-soft' : 'text-ink-muted hover:text-ink',
                )}
              >
                <input type="radio" name={`${formId}-mode`} value={m.value} checked={values.mode === m.value} onChange={() => setValues((v) => ({ ...v, mode: m.value }))} className="sr-only" />
                <span aria-hidden="true">{m.icon}</span>
                {m.label}
              </label>
            ))}
          </div>
          <p className="mt-2 px-1 text-xs text-ink-subtle">
            {values.mode === 'route' ? 'One of the routes planned for this depot.' : 'A trip nobody planned: it is saved for this trip only and kept out of the routes list.'}
          </p>
        </fieldset>

        {values.mode === 'route' ? (
          <SelectField
            label="Route"
            value={values.route_id}
            onChange={(e) => set('route_id', e.target.value)}
            error={errors.route_id}
            placeholder={routes.isPending ? 'Loading routes…' : routes.data?.length === 0 ? 'No routes in this depot' : 'Choose a route…'}
            options={(routes.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
            hint={
              routes.isError
                ? 'Routes could not be loaded. Close and try again, or make a one-off trip.'
                : route
                  ? [route.origin_name && route.destination_name ? `${route.origin_name} → ${route.destination_name}` : null, route.distance_km !== null ? `${route.distance_km} km` : null, route.estimated_duration_seconds !== null ? formatDuration(route.estimated_duration_seconds) : null]
                      .filter(Boolean)
                      .join(' · ')
                  : undefined
            }
          />
        ) : (
          <div className="space-y-1">
            <TextField label="From" value={values.origin_name} onChange={(e) => set('origin_name', e.target.value)} error={errors.origin_name} autoComplete="off" hint="A place name the driver knows, e.g. Bole warehouse." />
            <TextField label="From coordinates" optional inputMode="decimal" value={values.origin} onChange={(e) => set('origin', e.target.value)} error={errors.origin} hint={COORDINATES_HINT} autoComplete="off" spellCheck={false} />
            <TextField label="To" value={values.destination_name} onChange={(e) => set('destination_name', e.target.value)} error={errors.destination_name} autoComplete="off" />
            <TextField label="To coordinates" optional inputMode="decimal" value={values.destination} onChange={(e) => set('destination', e.target.value)} error={errors.destination} hint={COORDINATES_HINT} autoComplete="off" spellCheck={false} />
          </div>
        )}

        <fieldset className="space-y-1">
          <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">When (Addis Ababa time)</legend>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField label="Leaves" type="datetime-local" alwaysFloat value={values.start} onChange={(e) => set('start', e.target.value)} error={errors.start} />
            <TextField label="Back by" type="datetime-local" alwaysFloat optional={estimate !== null} value={values.end} onChange={(e) => set('end', e.target.value)} error={errors.end} hint={endHint} />
          </div>
        </fieldset>
      </form>
    </Drawer>
  )
}

export function withoutKey<K extends string>(errors: Partial<Record<K, string>>, key: K): Partial<Record<K, string>> {
  const next = { ...errors }
  delete next[key]
  return next
}

function blank(): Values {
  return { mode: 'route', route_id: '', origin_name: '', origin: '', destination_name: '', destination: '', start: toAddisInput(nextQuarterHour()), end: '' }
}
