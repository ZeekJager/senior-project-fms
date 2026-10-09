import type { ReactNode } from 'react'
import { cn } from '@/components/ui'

interface EmptyStateProps {
  icon: ReactNode
  heading: string
  description?: ReactNode
  /** Usually one primary button: the next step out of the empty state. */
  action?: ReactNode
  className?: string
}

/** What a list shows when it has nothing: an icon, one line of heading, a short why, and the way forward. */
export function EmptyState({ icon, heading, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-16 text-center', className)}>
      <div className="relative mb-5">
        <div className="absolute inset-0 rounded-full bg-brand/20 blur-xl" aria-hidden="true" />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-gradient-to-b from-surface to-surface-muted text-brand-ink shadow-card [&_svg]:h-6 [&_svg]:w-6">
          {icon}
        </div>
      </div>
      <h3 className="text-base font-semibold tracking-tight text-ink">{heading}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
