import { BellOff, Check, CheckCheck, Crosshair, TrendingUp } from 'lucide-react'
import { EmptyState } from '@/components/shared'
import { Badge, Button, cn, type BadgeTone } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { ago, type OverviewAlert, type Severity } from './overview'

// The command center's alerts (FMS-89): every active alert of the depot, most severe first, acknowledged and
// resolved from here (alert:ack, alert:resolve). New ones arrive over the socket (alert.created) and move into
// place; another console's acknowledgement shows here at once (alert.updated).

export const SEVERITY: Record<Severity, { label: string; tone: BadgeTone }> = {
  critical: { label: 'Critical', tone: 'danger' },
  high: { label: 'High', tone: 'warning' },
  medium: { label: 'Medium', tone: 'info' },
  low: { label: 'Low', tone: 'neutral' },
}

interface AlertsPanelProps {
  alerts: readonly OverviewAlert[]
  now: number
  canAck: boolean
  canResolve: boolean
  /** The alert whose action is being sent, and which. */
  pending: { id: string; action: 'acknowledge' | 'resolve' } | null
  /** Per alert, why its last action failed. */
  errors: ReadonlyMap<string, unknown>
  onAction: (id: string, action: 'acknowledge' | 'resolve') => void
  /** Offered when the alert's vehicle is on the map. */
  onShowVehicle?: (vehicleId: string) => void
  onMap: (vehicleId: string) => boolean
}

function failure(error: unknown): string {
  if (error instanceof ApiError && error.code === 'CONFLICT_INVALID_STATE_TRANSITION') return 'Someone else dealt with it a moment ago.'
  return 'That did not go through. Try again.'
}

export function AlertsPanel({ alerts, now, canAck, canResolve, pending, errors, onAction, onShowVehicle, onMap }: AlertsPanelProps) {
  if (alerts.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-3 py-3">
        <EmptyState icon={<BellOff />} heading="No active alerts" description="A new alert appears here the moment it is raised." headingLevel="h3" />
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line px-3 py-3">
      <ul className="space-y-2" aria-label="Active alerts">
        {alerts.map((a) => {
          const busy = pending?.id === a.id
          const error = errors.get(a.id)
          return (
            <li
              key={a.id}
              className={cn(
                'rounded-control border bg-surface px-3.5 py-3',
                a.severity === 'critical' && a.status === 'open' ? 'border-danger/40 bg-danger-soft/40' : 'border-line',
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={SEVERITY[a.severity].tone} dot>
                  {SEVERITY[a.severity].label}
                </Badge>
                {a.status === 'acknowledged' && (
                  <Badge tone="neutral" icon={<Check aria-hidden="true" />}>
                    Acknowledged
                  </Badge>
                )}
                {a.escalation_level > 0 && (
                  <Badge tone="danger" icon={<TrendingUp aria-hidden="true" />}>
                    Escalated
                  </Badge>
                )}
                <span className="tabular ml-auto text-xs text-ink-subtle">{ago(a.last_occurred_at, now)}</span>
              </div>
              <p className="mt-2 text-sm font-medium text-ink [overflow-wrap:anywhere]">{a.title}</p>
              {a.message && <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted [overflow-wrap:anywhere]">{a.message}</p>}
              {(a.registration_number || a.occurrence_count > 1) && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-xs text-ink-subtle">
                  {a.registration_number && <span className="plate text-ink">{a.registration_number}</span>}
                  {a.occurrence_count > 1 && <span className="tabular">{a.occurrence_count} times</span>}
                </p>
              )}
              {error !== undefined && (
                <p className="mt-2 text-xs text-danger" role="alert">
                  {failure(error)}
                </p>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {canAck && a.status === 'open' && (
                  <Button
                    size="sm"
                    variant={a.severity === 'critical' ? 'primary' : 'secondary'}
                    loading={busy && pending?.action === 'acknowledge'}
                    disabled={busy}
                    onClick={() => onAction(a.id, 'acknowledge')}
                    leadingIcon={<Check className="h-3.5 w-3.5" />}
                    aria-label={`Acknowledge: ${a.title}`}
                  >
                    Acknowledge
                  </Button>
                )}
                {canResolve && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy && pending?.action === 'resolve'}
                    disabled={busy}
                    onClick={() => onAction(a.id, 'resolve')}
                    leadingIcon={<CheckCheck className="h-3.5 w-3.5" />}
                    aria-label={`Resolve: ${a.title}`}
                  >
                    Resolve
                  </Button>
                )}
                {onShowVehicle && a.vehicle_id && onMap(a.vehicle_id) && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onShowVehicle(a.vehicle_id!)} leadingIcon={<Crosshair className="h-3.5 w-3.5" />}>
                    Show on map
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
