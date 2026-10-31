import { ShieldCheck, UserRound } from 'lucide-react'
import { EmptyState } from '@/components/shared'
import { Badge, cn } from '@/components/ui'
import { SEVERITY } from './AlertsPanel'
import { ago, incidentTypeLabel, type OverviewIncident } from './overview'

// The command center's incidents (FMS-89): what drivers and staff reported that is still being dealt with (open,
// investigating), most severe first. One opens its drawer, where it is taken on, assigned, and resolved.

export const INCIDENT_STATUS: Record<OverviewIncident['status'], { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' }> = {
  open: { label: 'Open', tone: 'danger' },
  investigating: { label: 'Investigating', tone: 'warning' },
  resolved: { label: 'Resolved', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
}

export function IncidentsPanel({ incidents, now, onOpen }: { incidents: readonly OverviewIncident[]; now: number; onOpen: (id: string) => void }) {
  if (incidents.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-3 py-3">
        <EmptyState icon={<ShieldCheck />} heading="No active incidents" description="An incident a driver reports appears here as soon as it is sent." headingLevel="h3" />
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line px-3 py-3">
      <ul className="space-y-2" aria-label="Active incidents">
        {incidents.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => onOpen(i.id)}
              className={cn(
                'focus-ring block w-full rounded-control border bg-surface px-3.5 py-3 text-left transition-[background-color,border-color] duration-150 hover:bg-surface-muted',
                i.severity === 'critical' && i.status === 'open' ? 'border-danger/40' : 'border-line hover:border-line-strong',
              )}
            >
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone={SEVERITY[i.severity].tone} dot>
                  {SEVERITY[i.severity].label}
                </Badge>
                <Badge tone={INCIDENT_STATUS[i.status].tone}>{INCIDENT_STATUS[i.status].label}</Badge>
                <span className="tabular ml-auto text-xs text-ink-subtle">{ago(i.occurred_at, now)}</span>
              </span>
              <span className="mt-2 flex items-baseline gap-2 text-sm font-medium text-ink">
                {incidentTypeLabel(i.incident_type)}
                {i.registration_number && <span className="plate text-xs font-normal text-ink-muted">{i.registration_number}</span>}
              </span>
              <span className="mt-0.5 line-clamp-2 block text-xs text-ink-muted [overflow-wrap:anywhere]">{i.description}</span>
              <span className="mt-2 flex items-center gap-1.5 text-xs text-ink-subtle">
                <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {i.assigned_to ? <span className="truncate text-ink">{i.assigned_to.full_name}</span> : <span className="italic">Nobody has taken it on</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
