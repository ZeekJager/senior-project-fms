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
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-card bg-brand-soft text-brand-ink [&_svg]:h-6 [&_svg]:w-6">
        {icon}
      </div>
      <h3 className="text-base font-semibold tracking-tight text-ink">{heading}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
