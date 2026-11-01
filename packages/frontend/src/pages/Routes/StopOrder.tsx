import { AlertCircle, CheckCircle2, Shuffle, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useOptimiseRoute, type Route, type RouteOptimisation } from './api'
import { optimiseBlocker, sameStops, type StopValues } from './routeForm'

/** `after` is the list put into the form: once the stops are edited again, Undo would lose that edit, so it goes. */
type Outcome = { kind: 'reordered'; result: RouteOptimisation; before: StopValues[]; after: StopValues[] } | { kind: 'shortest' } | { kind: 'error'; message: string }

interface StopOrderProps {
  route: Route
  stops: StopValues[]
  /** Puts the stops in a new order in the form (nothing is saved until Save changes). */
  onReorder: (stops: StopValues[]) => void
}

/**
 * Shortest order of the saved stops (FMS-86, docs/eta.md): the routing engine's suggestion, never longer than the
 * saved order, put into the form for the dispatcher to check and save like any edit.
 */
export function StopOrder({ route, stops, onReorder }: StopOrderProps) {
  const optimise = useOptimiseRoute()
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  useEffect(() => setOutcome(null), [route.id, route.version])

  const blocker = optimiseBlocker(route)
  const reordered = outcome?.kind === 'reordered' && outcome.after === stops
  const unsaved = !reordered && !sameStops(stops, route)

  async function run() {
    setOutcome(null)
    try {
      const result = await optimise.mutateAsync(route.id)
      if (!result.changed) return setOutcome({ kind: 'shortest' })
      const after = result.order.map((i) => stops[i])
      onReorder(after)
      setOutcome({ kind: 'reordered', result, before: stops, after })
    } catch (err) {
      setOutcome({ kind: 'error', message: errorText(err) })
    }
  }

  function undo() {
    if (outcome?.kind !== 'reordered' || !reordered) return
    onReorder(outcome.before)
    setOutcome(null)
  }

  return (
    <div className="rounded-control border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-xs text-ink-muted">
          {blocker ?? (unsaved ? 'Save your changes to the stops first: the order is worked out from the saved route.' : 'Let the road decide the order: the shortest drive through these stops.')}
        </p>
        {reordered ? (
          <Button variant="ghost" size="sm" leadingIcon={<Undo2 className="h-4 w-4" />} onClick={undo}>
            Undo
          </Button>
        ) : (
          <Button variant="secondary" size="sm" leadingIcon={<Shuffle className="h-4 w-4" />} loading={optimise.isPending} disabled={blocker !== null || unsaved} onClick={() => void run()}>
            Shortest order
          </Button>
        )}
      </div>
      <div role="status" className="empty:hidden">
        {outcome?.kind === 'reordered' && reordered && (
          <p className="mt-2.5 flex items-start gap-2 text-sm text-success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Reordered: {savingText(outcome.result)}. <span className="text-ink-muted">Save changes to keep this order.</span>
            </span>
          </p>
        )}
        {outcome?.kind === 'shortest' && (
          <p className="mt-2.5 flex items-start gap-2 text-sm text-ink">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            This is already the shortest order found.
          </p>
        )}
        {outcome?.kind === 'error' && (
          <p className="mt-2.5 flex items-start gap-2 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {outcome.message}
          </p>
        )}
      </div>
    </div>
  )
}

/** "12.4 km shorter (about 9 min less)", "118.4 km shorter (about 1 h 40 min less)". */
export function savingText({ original, optimised }: Pick<RouteOptimisation, 'original' | 'optimised'>): string {
  const km = Math.round((original.distance_km - optimised.distance_km) * 10) / 10
  const minutes = Math.round((original.duration_seconds - optimised.duration_seconds) / 60)
  const time = minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`
  return `${km.toLocaleString('en-US', { maximumFractionDigits: 1 })} km shorter${minutes > 0 ? ` (about ${time} less)` : ''}`
}

const REASONS: Record<string, string> = {
  route_without_ends: 'Give the origin and destination coordinates, and save, to find the shortest order.',
  stop_without_coordinates: 'Give every stop coordinates, and save, to find the shortest order.',
  no_road: 'The routing engine found no road between some of the stops. Check their coordinates.',
}

function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Could not reach the server. Check your connection and try again.'
  if (err.code === 'UPSTREAM_UNAVAILABLE') return 'The routing engine is not available right now. Try again in a minute.'
  if (err.code === 'NOT_FOUND') return 'This route no longer exists or is outside your depots.'
  const reason = err.details.find((d) => d.reason !== undefined && d.reason in REASONS)?.reason
  return reason ? REASONS[reason] : `The stops could not be ordered (${err.code}).`
}
