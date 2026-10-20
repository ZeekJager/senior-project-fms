import type { ReactNode } from 'react'
import { cn } from '@/components/ui'

// Pieces the driver screens share: large type, one idea per block.

/** A centred message in place of the screen's content: nothing today, no signal, done. */
export function Panel({ icon, title, tone, children }: { icon: ReactNode; title: string; tone: 'danger' | 'neutral' | 'success'; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card border border-line bg-surface px-6 py-12 text-center shadow-card">
      <span
        className={cn('mb-4 [&_svg]:h-10 [&_svg]:w-10 [&_svg]:stroke-[1.5]', tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-brand-ink')}
        aria-hidden="true"
      >
        {icon}
      </span>
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="mt-1.5 max-w-xs text-base text-ink-muted">{children}</p>
    </div>
  )
}

/** A refusal or a warning, under the control it is about. */
export function Note({ tone, icon, children }: { tone: 'danger' | 'warning'; icon: ReactNode; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-2.5 rounded-control border px-3.5 py-3 text-base [&>svg]:mt-0.5 [&>svg]:h-5 [&>svg]:w-5 [&>svg]:shrink-0',
        tone === 'danger' ? 'border-danger/25 bg-danger-soft text-danger' : 'border-warning/30 bg-warning-soft text-warning',
      )}
    >
      {icon}
      <span>{children}</span>
    </p>
  )
}
