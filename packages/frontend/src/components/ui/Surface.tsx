import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

/** The base surface: white (or raised dark) card, hairline border, soft shadow, 16px corners. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card border border-line bg-surface shadow-card', className)} {...rest} />
}

/** A shimmering placeholder block. Give it the size of what it stands in for, so nothing shifts on load. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('relative block overflow-hidden rounded-md bg-surface-sunken', className)}
    >
      <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/50 to-transparent dark:via-white/[0.06]" />
    </span>
  )
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand'

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-soft text-neutral ring-neutral/15',
  success: 'bg-success-soft text-success ring-success/20',
  warning: 'bg-warning-soft text-warning ring-warning/25',
  danger: 'bg-danger-soft text-danger ring-danger/20',
  info: 'bg-info-soft text-info ring-info/20',
  brand: 'bg-brand-soft text-brand-ink ring-brand/20',
}

/** A small tinted pill. Always has text: colour is never the only signal. */
export function Badge({ tone = 'neutral', dot, icon, children, className }: { tone?: BadgeTone; dot?: boolean; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset [&_svg]:h-3.5 [&_svg]:w-3.5',
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {icon}
      {children}
    </span>
  )
}
