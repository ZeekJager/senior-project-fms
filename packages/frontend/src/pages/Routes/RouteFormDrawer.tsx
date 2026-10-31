import { AlertCircle, Archive, ArrowDown, ArrowUp, MapPin, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Drawer, IconButton, SelectField, Skeleton, TextField, useToast } from '@/components/ui'
import { TripMap, type LatLng } from '@/components/TripMap'
import type { Depot } from '@/features/depots'
import { ApiError } from '@/lib/api/errors'
import { roadPoints, useCreateRoute, useRouteRoad, useUpdateRoute, type Route } from './api'
import {
  EMPTY_FORM,
  MAX_STOPS,
  changedFields,
  formField,
  formFromRoute,
  newStop,
  validateRouteForm,
  type FieldErrors,
  type FieldName,
  type RouteFormValues,
  type StopValues,
} from './routeForm'

interface RouteFormDrawerProps {
  open: boolean
  onClose: () => void
  /** Null: plan a new route. */
  route: Route | null
  depots: Depot[]
  /** Preselected depot for a new route (the filter's, or the only one). */
  defaultDepotId?: string
  /** Given when the user may retire this route: shown in the footer, apart from Save. */
  onRetire?: () => void
}

const CONFLICT_MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this route while you were editing. Close the panel to see their changes, then edit again.',
  NOT_FOUND: 'This route no longer exists or is outside your depots.',
}

const COORDINATES_HINT = 'Latitude, longitude: paste from a map, e.g. 9.0054, 38.7636.'

/**
 * Plan or edit a route: a slide-in panel over the list. Distance and time
 * are entered by hand until the mapping adapter (FMS-84) measures them.
 */
export function RouteFormDrawer({ open, onClose, route, depots, defaultDepotId, onRetire }: RouteFormDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const [values, setValues] = useState<RouteFormValues>(EMPTY_FORM)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const create = useCreateRoute()
  const update = useUpdateRoute()
  const saving = create.isPending || update.isPending

  useEffect(() => {
    if (!open) return
    setValues(route ? formFromRoute(route) : { ...EMPTY_FORM, depot_id: defaultDepotId ?? (depots.length === 1 ? depots[0].id : '') })
    setErrors({})
    setFormError(null)
  }, [open, route, defaultDepotId, depots])

  function clearError(field: FieldName) {
    if (!errors[field]) return
    setErrors((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  function set<K extends Exclude<keyof RouteFormValues, 'stops'>>(field: K, value: RouteFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }))
    clearError(field)
  }

  // Stop errors are keyed by row position, so any change to the list clears them.
  function setStops(next: (stops: StopValues[]) => StopValues[]) {
    setValues((current) => ({ ...current, stops: next(current.stops) }))
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([k]) => !k.startsWith('stops'))))
  }

  function setStop(index: number, patch: Partial<StopValues>) {
    setValues((current) => ({ ...current, stops: current.stops.map((s, i) => (i === index ? { ...s, ...patch } : s)) }))
    for (const key of Object.keys(patch)) clearError(`stops.${index}.${key}` as FieldName)
  }

  function moveStop(index: number, by: -1 | 1) {
    setStops((stops) => {
      const next = [...stops]
      ;[next[index], next[index + by]] = [next[index + by], next[index]]
      return next
    })
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setFormError(null)
    const { errors: found, input } = validateRouteForm(values)
    setErrors(found)
    if (!input) return

    try {
      if (route) {
        const patch = changedFields(input, route)
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: route.id, version: route.version, patch })
        toast({ title: 'Changes saved', description: `${input.name} is up to date.` })
      } else {
        await create.mutateAsync(input)
        toast({ title: 'Route added', description: `${input.name} can now be used for trips.` })
      }
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  async function restore() {
    if (!route || saving) return
    try {
      await update.mutateAsync({ id: route.id, version: route.version, patch: { is_active: true } })
      toast({ title: 'Route restored', description: `${route.name} can be used for trips again.` })
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  function showServerError(err: unknown) {
    if (!(err instanceof ApiError)) {
      setFormError('Could not reach the server. Check your connection and try again.')
      return
    }
    if (err.code === 'CONFLICT_DUPLICATE' && err.details.some((d) => d.field === 'name')) {
      return setErrors({ name: 'This depot already has an active route with this name.' })
    }
    const fieldErrors: FieldErrors = {}
    for (const detail of err.details) {
      const field = formField(detail.field)
      if (field) fieldErrors[field] = detail.reason === 'references_missing_record' ? 'Choose one of your depots.' : 'Check this value.'
    }
    if (Object.keys(fieldErrors).length > 0) return setErrors(fieldErrors)
    setFormError(CONFLICT_MESSAGES[err.code] ?? `The route could not be saved (${err.code}).`)
  }

  const retired = route !== null && !route.is_active

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={route ? `Edit ${route.name}` : 'Add route'}
      description={retired ? 'Retired: kept for past trips, not offered for new ones.' : route ? 'Changes are saved to the audit log. Past trips keep their own copy.' : 'A reusable plan that trips are created from.'}
      footer={
        <>
          {route && !retired && onRetire && (
            <Button variant="ghost" leadingIcon={<Archive className="h-4 w-4" />} className="mr-auto !text-danger hover:!bg-danger-soft hover:!text-danger" onClick={onRetire}>
              Retire route
            </Button>
          )}
          {retired && (
            <Button variant="ghost" leadingIcon={<RotateCcw className="h-4 w-4" />} className="mr-auto" onClick={() => void restore()} disabled={saving}>
              Restore route
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {route ? 'Save changes' : 'Add route'}
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

        <Section title="Route">
          <TextField label="Name" value={values.name} onChange={(e) => set('name', e.target.value)} error={errors.name} hint="How dispatchers will find it, e.g. Addis Ababa - Adama." autoComplete="off" />
          <SelectField
            label="Depot"
            value={values.depot_id}
            onChange={(e) => set('depot_id', e.target.value)}
            error={errors.depot_id}
            placeholder="Choose a depot…"
            options={depots.map((d) => ({ value: d.id, label: d.name }))}
          />
        </Section>

        <Section title="From">
          <TextField label="Origin" optional value={values.origin_name} onChange={(e) => set('origin_name', e.target.value)} error={errors.origin_name} autoComplete="off" />
          <TextField label="Origin coordinates" optional inputMode="decimal" value={values.origin} onChange={(e) => set('origin', e.target.value)} error={errors.origin} hint={COORDINATES_HINT} autoComplete="off" spellCheck={false} />
        </Section>

        <fieldset className="space-y-3">
          <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Stops on the way</legend>
          {values.stops.length === 0 ? (
            <p className="text-sm text-ink-subtle">No stops: the route goes straight from origin to destination.</p>
          ) : (
            <ol className="space-y-3">
              {values.stops.map((stop, i) => (
                <li key={stop.key} className="rounded-control border border-line bg-surface-sunken/40 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
                      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                      Stop {i + 1}
                    </span>
                    <span className="flex items-center gap-0.5">
                      <IconButton size="sm" label={`Move stop ${i + 1} up`} icon={<ArrowUp />} disabled={i === 0} onClick={() => moveStop(i, -1)} />
                      <IconButton size="sm" label={`Move stop ${i + 1} down`} icon={<ArrowDown />} disabled={i === values.stops.length - 1} onClick={() => moveStop(i, 1)} />
                      <IconButton size="sm" label={`Remove stop ${i + 1}`} icon={<Trash2 />} onClick={() => setStops((stops) => stops.filter((_, j) => j !== i))} />
                    </span>
                  </div>
                  <div className="grid gap-x-3 sm:grid-cols-2">
                    {/* The card says which stop; the accessible names repeat it for screen readers. */}
                    <TextField label="Name" aria-label={`Stop ${i + 1} name`} value={stop.name} onChange={(e) => setStop(i, { name: e.target.value })} error={errors[`stops.${i}.name`]} autoComplete="off" />
                    <TextField label="Coordinates" aria-label={`Stop ${i + 1} coordinates`} optional inputMode="decimal" value={stop.coordinates} onChange={(e) => setStop(i, { coordinates: e.target.value })} error={errors[`stops.${i}.coordinates`]} autoComplete="off" spellCheck={false} />
                  </div>
                </li>
              ))}
            </ol>
          )}
          {errors.stops && <p className="text-xs text-danger">{errors.stops}</p>}
          <Button variant="secondary" size="sm" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setStops((stops) => [...stops, newStop()])} disabled={values.stops.length >= MAX_STOPS}>
            Add stop
          </Button>
        </fieldset>

        <Section title="To">
          <TextField label="Destination" optional value={values.destination_name} onChange={(e) => set('destination_name', e.target.value)} error={errors.destination_name} autoComplete="off" />
          <TextField label="Destination coordinates" optional inputMode="decimal" value={values.destination} onChange={(e) => set('destination', e.target.value)} error={errors.destination} hint={COORDINATES_HINT} autoComplete="off" spellCheck={false} />
        </Section>

        <Section title="Plan">
          <TextField
            label="Expected distance"
            optional
            inputMode="decimal"
            value={values.distance_km}
            onChange={(e) => set('distance_km', e.target.value)}
            error={errors.distance_km}
            hint={distanceHint(route)}
            trailing={<span className="text-xs">km</span>}
          />
          <div className="grid grid-cols-2 gap-x-4">
            <TextField label="Estimated time" optional inputMode="numeric" value={values.hours} onChange={(e) => set('hours', e.target.value)} error={errors.hours} trailing={<span className="text-xs">h</span>} />
            <TextField label="Minutes" optional inputMode="numeric" value={values.minutes} onChange={(e) => set('minutes', e.target.value)} error={errors.minutes} trailing={<span className="text-xs">min</span>} />
          </div>
        </Section>

        {route?.measured_at && <RoadPreview route={route} />}
      </form>
    </Drawer>
  )
}

/** What the distance is and what leaving it blank does (FMS-84). */
function distanceHint(route: Route | null): string {
  if (route?.distance_source === 'road') return 'Measured along the road. Type a distance to use your own instead.'
  if (route?.distance_source === 'manual') return 'Typed in. Clear it to measure the road between the coordinates.'
  return 'Used to check fuel use. Leave it blank to measure the road between the origin and destination coordinates.'
}

/** The road the saved route follows, as measured (FMS-84). */
function RoadPreview({ route }: { route: Route }) {
  const road = useRouteRoad(route)
  const point = (c: Route['origin']): LatLng | null => (c ? [c.latitude, c.longitude] : null)
  return (
    <Section title="Road">
      {road.isPending ? (
        <Skeleton className="h-56 w-full rounded-card" />
      ) : (
        <TripMap
          label={`Road of ${route.name}`}
          planned={{ origin: point(route.origin), destination: point(route.destination) }}
          road={roadPoints(road.data)}
          track={[]}
          className="h-56"
        />
      )}
      <p className="mt-2 text-xs text-ink-subtle">The road as it was when the route was saved. It is measured again when the origin, destination or stops change.</p>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</legend>
      {children}
    </fieldset>
  )
}
