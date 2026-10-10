import type { ReactNode } from 'react'
import { cn, Skeleton } from '@/components/ui'

// Stat cards for list screens (vehicles, drivers): each shows one figure and
// applies its filter to the table below when clicked.

export type StatTone = 'brand' | 'success' | 'orange' | 'warning' | 'danger'

const ICON_TONE: Record<StatTone, string> = {
  brand: 'bg-brand-soft text-brand-ink ring-brand/20',
  success: 'bg-success-soft text-success ring-success/20',
  orange: 'bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-400/10 dark:text-orange-300 dark:ring-orange-400/25',
  warning: 'bg-warning-soft text-warning ring-warning/25',
  danger: 'bg-danger-soft text-danger ring-danger/20',
}

const BAR_TONE: Record<StatTone, string> = {
  brand: 'bg-brand',
  success: 'bg-emerald-500',
  orange: 'bg-orange-500',
  warning: 'bg-amber-400',
  danger: 'bg-red-500',
}

export interface StatCardProps {
  label: string
  value: number | undefined
  isLoading: boolean
  icon: ReactNode
  tone: StatTone
  pressed: boolean
  onClick: () => void
  footer: ReactNode
}

/** A clickable figure: label, big number, icon, and a footer (a share bar). Pressed while its filter applies. */
export function StatCard({ label, value, isLoading, icon, tone, pressed, onClick, footer }: StatCardProps) {
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

/** "62%" with a bar, under a stat. */
export function StatShare({ value, tone, caption }: { value: number; tone: StatTone; caption: string }) {
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

