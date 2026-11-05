import L from 'leaflet'
import { AlertCircle, Archive, Eraser, RotateCcw, Undo2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { Marker, Polygon, Polyline } from 'react-leaflet'
import { GeofenceLayer } from '@/components/GeofenceLayer'
import { Button, Drawer, SelectField, TextAreaField, TextField, cn, useToast } from '@/components/ui'
import type { Depot } from '@/features/depots'
import { APPLIES_LABELS, KIND_LABELS, areaLabel, ringOf, type Geofence, type GeofenceApplies, type GeofenceKind } from '@/features/geofences'
import { ApiError } from '@/lib/api/errors'
import { useCreateGeofence, useRestoreGeofence, useUpdateGeofence, type GeofenceInput } from './api'
import { GeofenceMap } from './GeofenceMap'
import { areaOf, outlineProblem, toPolygon, type Corner } from './outline'

interface GeofenceDrawerProps {
  open: boolean
  onClose: () => void
  /** Null: draw a new one. */
  geofence: Geofence | null
  depots: readonly Depot[]
  /** The depot to draw in first: the screen's filter. */
  defaultDepotId: string
  /** The depot's other fences, drawn faintly behind the outline. */
  others: readonly Geofence[]
  /** geofence:write: without it the panel only shows the fence. */
  canEdit: boolean
  onRemove?: () => void
}

interface Values {
  name: string
  depotId: string
  kind: GeofenceKind
  applies: GeofenceApplies
  description: string
}

type Field = 'name' | 'depotId' | 'outline'

const SERVER_MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this geofence while you were editing. Close the panel to see their change, then edit again.',
  CONFLICT_INVALID_STATE_TRANSITION: 'This geofence was removed meanwhile. Restore it before changing it.',
  NOT_FOUND: 'This geofence no longer exists.',
}

const POLYGON_REASONS: Record<string, string> = {
  self_intersecting: 'The edges cross. Drag a corner so the outline goes around the area without crossing itself.',
  too_small: 'Too small: draw it at least 20 m across.',
  too_large: 'Too large: draw it at most 500 km across.',
  too_few_points: 'Place at least 3 corners.',
  too_many_points: 'At most 500 corners.',
}

const cornerIcon = (first: boolean) =>
  L.divIcon({ className: '', html: `<span class="geofence-corner${first ? ' geofence-corner--first' : ''}"></span>`, iconSize: [14, 14], iconAnchor: [7, 7] })

/**
 * Draw or change a geofence (S-32, FMS-90): its outline on the map (click to place corners in order around the
 * area, drag one to move it), what it is, and when it applies. A change to its outline, kind or depot closes the
 * violations it has open; vehicles are judged again from their next crossing.
 */
export function GeofenceDrawer({ open, onClose, geofence, depots, defaultDepotId, others, canEdit, onRemove }: GeofenceDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const create = useCreateGeofence()
  const update = useUpdateGeofence()
  const restore = useRestoreGeofence()
  const saving = create.isPending || update.isPending || restore.isPending
  const removed = geofence !== null && !geofence.is_active
  const editable = canEdit && !removed

  const [values, setValues] = useState<Values>({ name: '', depotId: '', kind: 'keep_in', applies: 'always', description: '' })
  const [corners, setCorners] = useState<Corner[]>([])
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setValues(
      geofence
        ? { name: geofence.name, depotId: geofence.depot_id, kind: geofence.kind, applies: geofence.applies, description: geofence.description ?? '' }
        : { name: '', depotId: defaultDepotId || (depots.length === 1 ? depots[0].id : ''), kind: 'keep_in', applies: 'always', description: '' },
    )
    setCorners(geofence ? ringOf(geofence.polygon) : [])
    setErrors({})
    setFormError(null)
  }, [open, geofence])

  const background = useMemo(() => others.filter((g) => g.geofence_id !== geofence?.geofence_id && g.depot_id === values.depotId), [others, geofence, values.depotId])
  // The view frames the fence being edited, else the depot's others; it re-frames only when the panel opens or the depot changes.
  const fit = geofence ? ringOf(geofence.polygon) : background.flatMap((g) => ringOf(g.polygon))
  const problem = outlineProblem(corners)

  function set<K extends keyof Values>(field: K, value: Values[K]) {
    setValues((v) => ({ ...v, [field]: value }))
    if (field === 'name' || field === 'depotId') setErrors((e) => ({ ...e, [field]: undefined }))
  }

  function changeCorners(next: Corner[]) {
    setCorners(next)
    setErrors((e) => ({ ...e, outline: undefined }))
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!editable || saving) return
    setFormError(null)
    const found: Partial<Record<Field, string>> = {}
    const name = values.name.trim()
    if (!name) found.name = 'Name the geofence, e.g. Bole yard.'
    else if (name.length > 120) found.name = 'At most 120 characters.'
    if (!values.depotId) found.depotId = 'Choose the depot whose vehicles it is for.'
    if (problem) found.outline = problem
    setErrors(found)
    if (Object.keys(found).length > 0) return

    const input: GeofenceInput = { depot_id: values.depotId, name, description: values.description.trim() || null, kind: values.kind, applies: values.applies, polygon: toPolygon(corners) }
    try {
      if (geofence) {
        const patch = changed(input, geofence)
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: geofence.geofence_id, version: geofence.version, patch })
        toast({ title: 'Geofence saved', description: `${name} applies from the next GPS ping.` })
      } else {
        await create.mutateAsync(input)
        toast({ title: 'Geofence drawn', description: `${name} applies from the next GPS ping.` })
      }
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  async function onRestore() {
    if (!geofence || saving) return
    try {
      await restore.mutateAsync(geofence.geofence_id)
      toast({ title: 'Geofence restored', description: `${geofence.name} applies again from each vehicle's next crossing.` })
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  function showServerError(err: unknown) {
    if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
    if (err.code === 'CONFLICT_DUPLICATE') return setErrors({ name: 'The depot already has a geofence with this name.' })
    const polygon = err.details.find((d) => d.field === 'polygon')
    if (polygon) return setErrors({ outline: (polygon.reason && POLYGON_REASONS[polygon.reason]) || 'Check the outline.' })
    if (err.details.some((d) => d.reason === 'geofence_limit')) return setErrors({ depotId: 'This depot already has 50 geofences. Remove one first.' })
    setFormError(SERVER_MESSAGES[err.code] ?? `The geofence could not be saved (${err.code}).`)
  }

  const title = geofence ? (editable ? `Edit ${geofence.name}` : geofence.name) : 'Draw geofence'
  const area = corners.length >= 3 ? areaLabel(areaOf(corners)) : null

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      className="sm:!max-w-[600px]"
      description={
        removed
          ? 'Removed: no vehicle is judged against it. Its past violations stay.'
          : editable
            ? 'Leaving a stay-inside fence or entering a keep-out one raises an alert. Changes are audited.'
            : 'Leaving a stay-inside fence or entering a keep-out one raises an alert.'
      }
      footer={
        <>
          {geofence && editable && onRemove && (
            <Button variant="ghost" leadingIcon={<Archive className="h-4 w-4" />} className="mr-auto !text-danger hover:!bg-danger-soft hover:!text-danger" onClick={onRemove}>
              Remove geofence
            </Button>
          )}
          {editable ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form={formId} loading={saving}>
                {geofence ? 'Save changes' : 'Save geofence'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              {removed && canEdit && (
                <Button leadingIcon={<RotateCcw className="h-4 w-4" />} onClick={() => void onRestore()} loading={restore.isPending}>
                  Restore geofence
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5" aria-label="Geofence">
        <div role="alert" className="empty:-mb-5">
          {formError && (
            <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
        </div>

        <section aria-label="Outline" className="space-y-2">
          <GeofenceMap
            label="Geofence outline"
            className="h-[300px] sm:h-[340px]"
            fit={fit}
            fitKey={`${open}:${geofence?.geofence_id ?? 'new'}:${values.depotId}`}
            onMapClick={editable ? (c) => changeCorners([...corners, c]) : undefined}
            note={editable ? (corners.length < 3 ? 'Click the map to place corners in order around the area' : 'Drag a corner to move it') : undefined}
          >
            <GeofenceLayer geofences={background} />
            {corners.length >= 3 ? (
              <Polygon positions={corners} interactive={false} pathOptions={{ className: 'geofence-draft', weight: 2 }} />
            ) : (
              corners.length === 2 && <Polyline positions={corners} interactive={false} pathOptions={{ className: 'geofence-draft', weight: 2 }} />
            )}
            {editable
              ? corners.map((c, i) => (
                  <Marker
                    key={i}
                    position={c}
                    draggable
                    icon={cornerIcon(i === 0)}
                    title={`Corner ${i + 1}`}
                    eventHandlers={{
                      dragend: (e) => {
                        const { lat, lng } = (e.target as L.Marker).getLatLng()
                        changeCorners(corners.map((old, j) => (j === i ? [lat, lng] : old)))
                      },
                    }}
                  />
                ))
              : corners.length >= 3 && geofence && <GeofenceLayer geofences={[geofence]} selectedId={geofence.geofence_id} />}
          </GeofenceMap>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className={cn('flex-1 text-xs', errors.outline ? 'font-medium text-danger' : 'text-ink-subtle')} aria-live="polite">
              {errors.outline ?? (corners.length === 0 ? 'No corners yet.' : `${corners.length} ${corners.length === 1 ? 'corner' : 'corners'}${area ? ` · ${area}` : ''}`)}
            </p>
            {editable && (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" leadingIcon={<Undo2 className="h-3.5 w-3.5" />} disabled={corners.length === 0} onClick={() => changeCorners(corners.slice(0, -1))}>
                  Undo corner
                </Button>
                <Button size="sm" variant="ghost" leadingIcon={<Eraser className="h-3.5 w-3.5" />} disabled={corners.length === 0} onClick={() => changeCorners([])}>
                  Clear
                </Button>
              </div>
            )}
          </div>
        </section>

        <fieldset disabled={!editable} className="space-y-4 disabled:opacity-80">
          <TextField label="Name" value={values.name} onChange={(e) => set('name', e.target.value)} error={errors.name} hint="As dispatchers call the place, e.g. Bole yard." autoComplete="off" maxLength={120} />
          <SelectField
            label="Depot"
            value={values.depotId}
            onChange={(e) => set('depotId', e.target.value)}
            error={errors.depotId}
            placeholder="Choose a depot"
            options={depots.map((d) => ({ value: d.id, label: d.name }))}
            hint="Its vehicles are judged against the fence."
          />
          <div role="radiogroup" aria-label="Kind" className="grid gap-2 sm:grid-cols-2">
            {(['keep_in', 'keep_out'] as const).map((kind) => (
              <label
                key={kind}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-control border px-3.5 py-3 text-sm transition-colors',
                  values.kind === kind ? 'border-brand bg-brand-soft/60' : 'border-line hover:bg-surface-muted',
                )}
              >
                <input type="radio" name={`${formId}-kind`} value={kind} checked={values.kind === kind} onChange={() => set('kind', kind)} className="mt-0.5 accent-[rgb(var(--c-brand))]" />
                <span>
                  <span className="flex items-center gap-2 font-medium text-ink">
                    <span className={`geofence-key geofence-key--${kind}`} aria-hidden />
                    {KIND_LABELS[kind]}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-muted">{kind === 'keep_in' ? 'A yard or operating area: leaving it raises an alert.' : 'A no-go zone: entering it raises an alert.'}</span>
                </span>
              </label>
            ))}
          </div>
          <SelectField
            label="Applies"
            value={values.applies}
            onChange={(e) => set('applies', e.target.value as GeofenceApplies)}
            options={(['always', 'off_trip'] as const).map((a) => ({ value: a, label: APPLIES_LABELS[a] }))}
            hint={values.applies === 'off_trip' ? 'A vehicle on a trip may leave: for a yard at night.' : 'On trips and off them.'}
          />
          <TextAreaField label="Notes" optional value={values.description} onChange={(e) => set('description', e.target.value)} rows={2} maxLength={500} hint="Why it is there, e.g. Parked overnight; gate closes at 20:00." />
        </fieldset>

        {geofence && (
          <p className="text-xs text-ink-subtle">
            {geofence.updated_by_name ? `Last changed by ${geofence.updated_by_name}, ` : 'Last changed '}
            {new Date(geofence.updated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.
          </p>
        )}
      </form>
    </Drawer>
  )
}

/** The fields that differ from the fence as loaded: a PATCH sends only these. */
function changed(input: GeofenceInput, g: Geofence): Partial<GeofenceInput> {
  const patch: Partial<GeofenceInput> = {}
  if (input.name !== g.name) patch.name = input.name
  if (input.depot_id !== g.depot_id) patch.depot_id = input.depot_id
  if (input.kind !== g.kind) patch.kind = input.kind
  if (input.applies !== g.applies) patch.applies = input.applies
  if (input.description !== g.description) patch.description = input.description
  if (JSON.stringify(input.polygon.coordinates) !== JSON.stringify(toPolygon(ringOf(g.polygon)).coordinates)) patch.polygon = input.polygon
  return patch
}
