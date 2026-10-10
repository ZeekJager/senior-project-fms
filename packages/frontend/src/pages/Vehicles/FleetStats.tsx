import { AlertTriangle, CheckCircle2, Truck, Wrench } from 'lucide-react'
import { useState, type ReactNode } from 'react'
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
        footer={<Share value={percent(counts.active, counts.total)} tone="success" caption="of the fleet available" />}
      />
      <StatCard
        label="In maintenance"
        value={counts.maintenance}
        isLoading={isLoading}
        icon={<Wrench />}
        tone="orange"
        pressed={focus === 'maintenance'}
        onClick={() => onSelect('maintenance')}
        footer={<Share value={percent(counts.maintenance, counts.total)} tone="orange" caption="of the fleet in the workshop" />}
      />
      <StatCard
        label="Maintenance flagged"
        value={counts.flagged}
        isLoading={isLoading}
        icon={<AlertTriangle />}
        tone="warning"
        pressed={focus === 'flagged'}
        onClick={() => onSelect('flagged')}
        footer={<Share value={percent(counts.flagged, counts.total)} tone="warning" caption="need a technician's look" />}
      />
    </section>
  )
}

type Tone = 'brand' | 'success' | 'orange' | 'warning'

const ICON_TONE: Record<Tone, string> = {
  brand: 'bg-brand-soft text-brand-ink ring-brand/20',
  success: 'bg-success-soft text-success ring-success/20',
  orange: 'bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-400/10 dark:text-orange-300 dark:ring-orange-400/25',
  warning: 'bg-warning-soft text-warning ring-warning/25',
}

const BAR_TONE: Record<Tone, string> = {
  brand: 'bg-brand',
  success: 'bg-emerald-500',
  orange: 'bg-orange-500',
  warning: 'bg-amber-400',
}

interface StatCardProps {
  label: string
  value: number | undefined
  isLoading: boolean
  icon: ReactNode
  tone: Tone
  pressed: boolean
  onClick: () => void
  footer: ReactNode
}

function StatCard({ label, value, isLoading, icon, tone, pressed, onClick, footer }: StatCardProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'focus-ring group relative flex flex-col overflow-hidden rounded-card border bg-surface p-4 text-left shadow-card sm:p-5',
        'transition-all duration-200 ease-smooth hover:-translate-y-0.5 hover:shadow-elevated',
        pressed ? 'border-brand/40 ring-1 ring-brand/25' : 'border-line hover:border-line-strong',
      )}
    >
      {/* A faint sheen from the corner; stronger on the card that drives the table. */}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-brand/10 blur-3xl transition-opacity duration-300',
          pressed ? 'opacity-100' : 'opacity-0 group-hover:opacity-60',
        )}
      />
      <span className="flex items-center justify-between">
        <span className="text-[13px] font-medium leading-tight text-ink-muted sm:text-sm">{label}</span>
        <span className={cn('hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset sm:flex [&_svg]:h-[18px] [&_svg]:w-[18px]', ICON_TONE[tone])}>
          {icon}
        </span>
      </span>
      <span className="tabular mt-2 text-2xl font-semibold tracking-tight text-ink sm:mt-3 sm:text-3xl">
        {isLoading || value === undefined ? <Skeleton className="h-9 w-16" /> : value.toLocaleString()}
      </span>
      <span className="mt-3 block sm:mt-4">{footer}</span>
    </button>
  )
}

function Share({ value, tone, caption }: { value: number; tone: Tone; caption: string }) {
  return (
    <span className="block">
      <span className="block h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <span className={cn('block h-full rounded-full transition-[width] duration-700 ease-smooth', BAR_TONE[tone])} style={{ width: `${value}%` }} />
      </span>
      <span className="mt-2 block text-xs text-ink-subtle">
        <span className="tabular font-medium text-ink-muted">{value}%</span> <span className="hidden sm:inline">{caption}</span>
      </span>
    </span>
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
