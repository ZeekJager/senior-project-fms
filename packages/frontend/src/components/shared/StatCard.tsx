import type { ReactNode } from 'react'
import { cn, Skeleton } from '@/components/ui'

// Stat cards for list screens (vehicles, drivers): each shows one figure and
// applies its filter to the table below when clicked.

export type StatTone = 'brand' | 'success' | 'orange' | 'warning' | 'danger'

const ICON_TONE: Record<StatTone, string> = {
  brand: 'text-brand-ink',
  success: 'text-success',
  orange: 'text-orange-600 dark:text-orange-300',
  warning: 'text-warning',
  danger: 'text-danger',
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

/** A clickable figure in a `stat-strip`: icon and label, big number, a footer (a share bar). Tinted while its filter applies. */
export function StatCard({ label, value, isLoading, icon, tone, pressed, onClick, footer }: StatCardProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'focus-ring group relative flex flex-col p-4 text-left focus-visible:ring-inset sm:p-5',
        'transition-colors duration-150 ease-smooth',
        pressed ? 'bg-brand-soft' : 'bg-surface hover:bg-surface-muted',
      )}
    >
      <span className="flex items-center gap-2 text-[13px] font-medium leading-tight text-ink-muted">
        <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center [&_svg]:h-[18px] [&_svg]:w-[18px]', ICON_TONE[tone])}>{icon}</span>
        {label}
      </span>
      <span className={cn('tabular mt-3 text-3xl font-semibold tracking-tight', pressed ? 'text-brand-ink' : 'text-ink')}>
        {isLoading || value === undefined ? <Skeleton className="h-9 w-16" /> : value.toLocaleString()}
      </span>
      <span className="mt-3 block">{footer}</span>
    </button>
  )
}

/** "62%" with a bar, under a stat. */
export function StatShare({ value, tone, caption }: { value: number; tone: StatTone; caption: string }) {
  return (
    <span className="block">
      <span className="block h-1 overflow-hidden rounded-full bg-surface-sunken">
        <span className={cn('block h-full rounded-full transition-[width] duration-700 ease-smooth', BAR_TONE[tone])} style={{ width: `${value}%` }} />
      </span>
      <span className="mt-2 block text-xs text-ink-subtle">
        <span className="tabular font-medium text-ink-muted">{value}%</span> <span className="hidden sm:inline">{caption}</span>
      </span>
    </span>
  )
}

