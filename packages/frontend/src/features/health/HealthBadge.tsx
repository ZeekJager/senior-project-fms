import { Clock } from 'lucide-react'
import { cn } from '@/components/ui'
import { BAND_LABELS, formatAge, healthViewOf, type HealthView } from './health'

const TONE: Record<HealthView, string> = {
  at_risk: 'bg-danger-soft text-danger ring-danger/20',
  watch: 'bg-warning-soft text-warning ring-warning/25',
  healthy: 'bg-success-soft text-success ring-success/20',
  stale: 'bg-neutral-soft text-neutral ring-neutral/15',
  unscored: '',
}

interface HealthBadgeProps {
  score: number | null
  updatedAt: string | null
  /** Given (prediction:read): the badge is a button that opens the breakdown. */
  onOpen?: () => void
  className?: string
}

/**
 * A vehicle's health score (FMS-56): green at 85 and up, amber 75 to 84, red below 75. A score more than
 * 25 hours old is grey and says STALE, whatever its value; a vehicle never scored shows a dash. The number
 * and the words carry the meaning, the colour repeats it.
 */
export function HealthBadge({ score, updatedAt, onOpen, className }: HealthBadgeProps) {
  const view = healthViewOf(score, updatedAt)
  if (view === 'unscored') {
    return (
      <span className={cn('text-ink-subtle', className)}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not scored yet</span>
      </span>
    )
  }
  const age = updatedAt ? `, scored ${formatAge(updatedAt)}` : ''
  const label = view === 'stale' ? `Health score ${score}, stale${age}` : `Health score ${score}, ${BAND_LABELS[view].toLowerCase()}${age}`
  const body = (
    <>
      {view === 'stale' ? (
        <>
          <Clock aria-hidden="true" />
          <span className="text-2xs font-semibold uppercase tracking-wider">Stale</span>
          <span className="tabular text-ink-subtle line-through decoration-1">{score}</span>
        </>
      ) : (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
          <span className="tabular font-semibold">{score}</span>
        </>
      )}
    </>
  )
  const classes = cn(
    'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs ring-1 ring-inset [&_svg]:h-3.5 [&_svg]:w-3.5',
    TONE[view],
    className,
  )
  if (!onOpen) {
    return (
      <span className={classes} title={label}>
        <span className="sr-only">{label}</span>
        <span aria-hidden="true" className="contents">
          {body}
        </span>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        // The row's own click opens something else (edit); this opens the breakdown.
        e.stopPropagation()
        onOpen()
      }}
      title={`${label}. Open the breakdown`}
      aria-label={`${label}. Open the breakdown`}
      className={cn(classes, 'focus-ring transition-[filter] duration-150 ease-smooth hover:brightness-95 dark:hover:brightness-125 coarse:h-9')}
    >
      {body}
    </button>
  )
}
