import { AlertTriangle, CheckCircle2, Truck, Wrench } from 'lucide-react'
import { useState } from 'react'
import { StatCard, StatShare } from '@/components/shared/StatCard'
import { cn, Skeleton } from '@/components/ui'
import type { VehicleFilters } from './filters'

interface Counts {
  total?: number
  active?: number
  maintenance?: number
  inactive?: number
  flagged?: number
}

type Focus = 'all' | 'active' | 'maintenance' | 'flagged'

interface FleetStatsProps {
  counts: Counts
  isLoading: boolean
  filters: VehicleFilters
  /** Applies the card's filter (or clears it when it is already applied). */
  onSelect: (focus: Focus) => void
}

const percent = (part: number | undefined, whole: number | undefined) =>
  part === undefined || !whole ? 0 : Math.round((part * 100) / whole)

function currentFocus(f: VehicleFilters): Focus | null {
  if (f.flagged && !f.status) return 'flagged'
  if (!f.flagged && f.status === 'active') return 'active'
  if (!f.flagged && f.status === 'maintenance') return 'maintenance'
  if (!f.flagged && !f.status) return 'all'
  return null
}

/**
 * The fleet at a glance: totals per state as clickable cards (each applies
 * its filter to the table below), with the active / maintenance / inactive
 * split drawn as a bar.
 */
export function FleetStats({ counts, isLoading, filters, onSelect }: FleetStatsProps) {
  const focus = currentFocus(filters)
  return (
    <section aria-label="Fleet summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        label="Total vehicles"
        value={counts.total}
        isLoading={isLoading}
        icon={<Truck />}
        tone="brand"
        pressed={focus === 'all'}
        onClick={() => onSelect('all')}
        footer={<CompositionBar counts={counts} isLoading={isLoading} />}
      />
      <StatCard
        label="Active"
        value={counts.active}
        isLoading={isLoading}
        icon={<CheckCircle2 />}
        tone="success"
        pressed={focus === 'active'}
        onClick={() => onSelect('active')}
        footer={<StatShare value={percent(counts.active, counts.total)} tone="success" caption="of the fleet available" />}
      />
      <StatCard
        label="In maintenance"
        value={counts.maintenance}
        isLoading={isLoading}
        icon={<Wrench />}
        tone="orange"
        pressed={focus === 'maintenance'}
        onClick={() => onSelect('maintenance')}
        footer={<StatShare value={percent(counts.maintenance, counts.total)} tone="orange" caption="of the fleet in the workshop" />}
      />
      <StatCard
        label="Maintenance flagged"
        value={counts.flagged}
        isLoading={isLoading}
        icon={<AlertTriangle />}
        tone="warning"
        pressed={focus === 'flagged'}
        onClick={() => onSelect('flagged')}
        footer={<StatShare value={percent(counts.flagged, counts.total)} tone="warning" caption="need a technician's look" />}
      />
    </section>
  )
}

const SEGMENTS = [
  { key: 'active', label: 'Active', className: 'bg-emerald-500' },
  { key: 'maintenance', label: 'Maintenance', className: 'bg-orange-500' },
  { key: 'inactive', label: 'Inactive', className: 'bg-slate-400' },
] as const

/** Active / maintenance / inactive as one stacked bar; hovering a segment names it. */
function CompositionBar({ counts, isLoading }: { counts: Counts; isLoading: boolean }) {
  const [hovered, setHovered] = useState<(typeof SEGMENTS)[number]['key'] | null>(null)
  const sum = SEGMENTS.reduce((n, s) => n + (counts[s.key] ?? 0), 0)
  if (isLoading) return <Skeleton className="h-1.5 w-full rounded-full" />
  const shown = SEGMENTS.find((s) => s.key === hovered)
  return (
    <span className="block">
      <span className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={SEGMENTS.map((s) => `${s.label} ${counts[s.key] ?? 0}`).join(', ')}>
        {sum > 0 &&
          SEGMENTS.map((s) => (
            <span
              key={s.key}
              onMouseEnter={() => setHovered(s.key)}
              onMouseLeave={() => setHovered(null)}
              className={cn('h-full transition-all duration-500 ease-smooth', s.className, hovered && hovered !== s.key && 'opacity-40')}
              style={{ width: `${((counts[s.key] ?? 0) * 100) / sum}%` }}
            />
          ))}
      </span>
      <span className="mt-2 hidden items-center gap-3 text-xs text-ink-subtle sm:flex" aria-hidden="true">
        {shown ? (
          <span className="tabular">
            <span className="font-medium text-ink-muted">{counts[shown.key] ?? 0}</span> {shown.label.toLowerCase()}
          </span>
        ) : (
          SEGMENTS.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 rounded-full', s.className)} />
              {s.label}
            </span>
          ))
        )}
      </span>
    </span>
  )
}
