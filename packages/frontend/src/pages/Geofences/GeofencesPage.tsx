import { AlertCircle, Fence, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { GeofenceLayer } from '@/components/GeofenceLayer'
import { ConfirmDialog, EmptyState } from '@/components/shared'
import { Badge, Button, Card, FilterSelect, Skeleton, ViewTabs, cn, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { APPLIES_LABELS, KIND_LABELS, areaLabel, ringOf, useGeofences, type Geofence } from '@/features/geofences'
import { ApiError } from '@/lib/api/errors'
import { useRemoveGeofence } from './api'
import { GeofenceDrawer } from './GeofenceDrawer'
import { GeofenceMap } from './GeofenceMap'

type View = 'active' | 'inactive'

/**
 * S-32 Geofences (FMS-90): the yards a depot's vehicles must stay inside and the zones they must keep out of,
 * listed and on a map. Leaving or entering one raises an alert. Everyone with tracking:read sees them; an
 * administrator (geofence:write) draws, changes and removes them.
 */
export function GeofencesPage() {
  const { hasPermission } = useAuth()
  const canEdit = hasPermission('geofence:write')
  const { toast } = useToast()
  const [params, setParams] = useSearchParams()
  const depotId = params.get('depot') ?? ''
  const view: View = params.get('view') === 'removed' ? 'inactive' : 'active'
  const depots = useDepots()
  const list = useGeofences(depotId, view)
  const active = useGeofences(depotId, 'active')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ geofence: Geofence | null } | null>(null)
  const [removing, setRemoving] = useState<Geofence | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const remove = useRemoveGeofence()

  const fences = list.data ?? []
  const depotNames = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d.name])), [depots.data])
  const fit = useMemo(() => fences.flatMap((g) => ringOf(g.polygon)), [fences])

  function setParam(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setSelectedId(null)
    setParams(next, { replace: true })
  }

  function open(g: Geofence) {
    setSelectedId(g.geofence_id)
    setDrawer({ geofence: g })
  }

  async function confirmRemove() {
    if (!removing) return
    setRemoveError(null)
    try {
      await remove.mutateAsync(removing.geofence_id)
      toast({ title: 'Geofence removed', description: `${removing.name} no longer raises alerts. Its past violations stay.` })
      setRemoving(null)
      setDrawer(null)
    } catch (err) {
      setRemoveError(err instanceof ApiError ? `It could not be removed (${err.code}).` : 'Could not reach the server. Try again.')
    }
  }

  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Geofences</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">Yards vehicles must stay inside and zones they must keep out of. Leaving or entering one alerts the depot’s dispatchers.</p>
        </div>
        {canEdit && (
          <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setDrawer({ geofence: null })} className="self-start sm:self-auto">
            Draw geofence
          </Button>
        )}
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewTabs
          label="Geofence views"
          value={view}
          onChange={(v) => setParam({ view: v === 'inactive' ? 'removed' : null })}
          options={[
            { value: 'active', label: 'In force', count: active.data?.length, isLoading: active.isPending, hint: 'Vehicles are judged against these' },
            { value: 'inactive', label: 'Removed', archived: true, hint: 'Kept with their past violations; can be restored' },
          ]}
        />
        {(depots.data?.length ?? 0) > 1 && <FilterSelect label="Depot" value={depotId} emptyValue="" onChange={(v) => setParam({ depot: v || null })} options={depotOptions} />}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(300px,2fr)_minmax(0,3fr)]">
        <Card className="min-h-0 overflow-hidden p-0 lg:max-h-[calc(100dvh-17rem)] lg:overflow-y-auto">
          {list.isPending ? (
            <ul aria-label="Loading geofences" className="divide-y divide-line">
              {[0, 1, 2].map((i) => (
                <li key={i} className="space-y-2 px-4 py-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </li>
              ))}
            </ul>
          ) : list.isError ? (
            <EmptyState
              icon={<AlertCircle />}
              heading="Geofences could not be loaded"
              description="Check your connection, then try again."
              action={
                <Button variant="secondary" onClick={() => void list.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : fences.length === 0 ? (
            view === 'inactive' ? (
              <EmptyState icon={<Fence />} heading="No removed geofences" description="A geofence you remove is kept here with its past violations, and can be restored." />
            ) : (
              <EmptyState
                icon={<Fence />}
                heading="No geofences yet"
                description={canEdit ? 'Draw a depot’s yard so a vehicle leaving it after hours raises an alert, or a zone its vehicles must keep out of.' : 'An administrator draws them. Until then no vehicle is judged against one.'}
                action={
                  canEdit ? (
                    <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setDrawer({ geofence: null })}>
                      Draw geofence
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : (
            <ul aria-label="Geofences" className="divide-y divide-line">
              {fences.map((g) => (
                <li key={g.geofence_id}>
                  <button
                    type="button"
                    onClick={() => open(g)}
                    onMouseEnter={() => setSelectedId(g.geofence_id)}
                    onFocus={() => setSelectedId(g.geofence_id)}
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none',
                      selectedId === g.geofence_id && 'bg-surface-muted',
                    )}
                  >
                    <span className={`geofence-key geofence-key--${g.kind} mt-1.5 shrink-0`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{g.name}</span>
                        <Badge tone={g.kind === 'keep_out' ? 'danger' : 'brand'}>{KIND_LABELS[g.kind]}</Badge>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink-subtle">
                        {[depotNames.get(g.depot_id), g.applies === 'off_trip' ? APPLIES_LABELS.off_trip : null, areaLabel(g.area_m2)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <GeofenceMap
          label="Geofences map"
          className="h-[50vh] min-h-[340px] shadow-soft lg:h-[calc(100dvh-17rem)] lg:min-h-[480px]"
          fit={fit}
          fitKey={`${depotId}:${view}:${list.dataUpdatedAt ? 'loaded' : 'loading'}`}
          note={list.isSuccess && fences.length === 0 ? 'Nothing to show' : undefined}
          legend={
            <ul aria-label="Map legend" className="flex flex-col gap-1.5">
              {(['keep_in', 'keep_out'] as const).map((kind) => (
                <li key={kind} className="flex items-center gap-2">
                  <span className={`geofence-key geofence-key--${kind}`} aria-hidden />
                  {KIND_LABELS[kind]}
                </li>
              ))}
            </ul>
          }
        >
          <GeofenceLayer geofences={fences} selectedId={selectedId} onSelect={(id) => open(fences.find((g) => g.geofence_id === id)!)} />
        </GeofenceMap>
      </div>

      <GeofenceDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        geofence={drawer?.geofence ?? null}
        depots={depots.data ?? []}
        defaultDepotId={depotId}
        others={active.data ?? []}
        canEdit={canEdit}
        onRemove={drawer?.geofence ? () => setRemoving(drawer.geofence) : undefined}
      />

      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null)
          setRemoveError(null)
        }}
        title={`Remove ${removing?.name ?? 'geofence'}?`}
        message="No vehicle will be judged against it, and any violation it has open now ends. Its past violations stay, and you can restore it."
        action="Remove geofence"
        onConfirm={confirmRemove}
        error={removeError}
        busy={remove.isPending}
      />
    </div>
  )
}
