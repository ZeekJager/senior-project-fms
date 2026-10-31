import { AlertCircle, ArrowUpRight, ClipboardCheck, Clock, Gauge } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/shared'
import { Badge, Button, cn, Drawer, Skeleton, type BadgeTone } from '@/components/ui'
import { useMaintenanceRisk } from './api'
import {
  AT_RISK_BELOW,
  BAND_LABELS,
  bandOf,
  featureLabel,
  formatAge,
  formatFactorValue,
  formatScoredAt,
  RISK_LABELS,
  type HealthBand,
  type MaintenanceRisk,
  type RiskLevel,
} from './health'

export interface HealthVehicle {
  id: string
  registration_number: string
}

interface HealthDrawerProps {
  /** Null: closed. */
  vehicle: HealthVehicle | null
  onClose: () => void
  /** Given (maintenance:write): "Schedule inspection" opens the repair form for this vehicle. */
  onSchedule?: (vehicle: HealthVehicle, risk: MaintenanceRisk) => void
  /** Rendered under the breakdown of a scored vehicle: S-19 asks what the inspection found there (FMS-128). */
  below?: (vehicle: HealthVehicle, risk: MaintenanceRisk) => ReactNode
}

const ARC_TONE: Record<HealthBand, string> = { at_risk: 'text-danger', watch: 'text-warning', healthy: 'text-success' }
const RISK_TONE: Record<RiskLevel, BadgeTone> = { high: 'danger', medium: 'warning', low: 'success' }

/**
 * The breakdown behind a vehicle's health score (S-19, FMS-56): the score on a 0-100 gauge with the alert
 * line, its risk level and breakdown chance, when it was scored and by which model, and the inputs that
 * raise its risk most. For prediction:read; dispatchers see the badge only.
 */
export function HealthDrawer({ vehicle, onClose, onSchedule, below }: HealthDrawerProps) {
  const risk = useMaintenanceRisk(vehicle?.id ?? null)
  const view = risk.data
  const scored = view?.health_score != null

  return (
    <Drawer
      open={vehicle !== null}
      onClose={onClose}
      title={vehicle ? `${vehicle.registration_number} health` : 'Vehicle health'}
      description="Its chance of a breakdown in the next 30 days, scored every night."
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {vehicle && (
            <Link
              to={`/maintenance?vehicle=${vehicle.id}`}
              className="focus-ring order-last inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-control px-3 text-sm font-medium text-brand-ink transition-colors hover:bg-brand-soft coarse:h-11 sm:order-none sm:mr-auto sm:w-auto"
            >
              View maintenance history
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {onSchedule && vehicle && view && scored && (
            <Button leadingIcon={<ClipboardCheck className="h-4 w-4" />} onClick={() => onSchedule(vehicle, view)}>
              Schedule inspection
            </Button>
          )}
        </div>
      }
    >
      {risk.isError ? (
        <p role="alert" className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          The health score could not be loaded. Close the panel and try again.
        </p>
      ) : !view ? (
        <HealthSkeleton />
      ) : !scored ? (
        <EmptyState
          icon={<Gauge />}
          heading="Not scored yet"
          description="The nightly scoring gives every vehicle in service a score at 02:00. This one has none yet."
          headingLevel="h3"
        />
      ) : (
        <div className="space-y-8">
          <HealthDetail view={view} />
          {vehicle && below?.(vehicle, view)}
        </div>
      )}
    </Drawer>
  )
}

export function HealthDetail({ view }: { view: MaintenanceRisk }) {
  const score = view.health_score!
  const band = bandOf(score)
  const chance = view.failure_probability === null ? null : Math.round(view.failure_probability * 100)
  return (
    <div className="space-y-8">
      <section aria-label="Health score" className="space-y-5">
        <ScoreGauge score={score} band={view.stale ? null : band} />
        {view.stale && (
          <p className="flex items-start gap-2 rounded-control bg-warning-soft px-3 py-2.5 text-sm text-warning">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              This score was set {formatAge(view.scored_at!)}: the last nightly scoring did not reach this vehicle. Treat it as out of date until the next run.
            </span>
          </p>
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
          <div>
            <dt className="text-xs text-ink-subtle">Risk level</dt>
            <dd className="mt-1">{view.risk_level ? <Badge tone={RISK_TONE[view.risk_level]} dot>{RISK_LABELS[view.risk_level]}</Badge> : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">Breakdown chance</dt>
            <dd className="mt-1 text-ink">
              {chance === null ? '—' : <span className="tabular font-semibold">{chance}%</span>}
              <span className="text-ink-muted"> within {view.prediction_horizon_days ?? 30} days</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">Last scored</dt>
            <dd className="mt-1 text-ink">
              {formatScoredAt(view.scored_at!)}
              <span className="text-ink-muted"> · {formatAge(view.scored_at!)}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">Model</dt>
            <dd className="mt-1 truncate text-ink-muted" title={view.model_name ?? undefined}>
              {view.model_version ?? '—'}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="health-factors" className="space-y-3">
        <div>
          <h3 id="health-factors" className="text-sm font-semibold text-ink">
            What drives it
          </h3>
          <p className="mt-1 text-xs text-ink-muted">
            {view.factors.length > 0
              ? 'The inputs raising this vehicle’s risk most, largest effect first, with its value when it was scored.'
              : 'Nothing stands out: no input raises this vehicle’s risk noticeably.'}
          </p>
        </div>
        {view.factors.length > 0 && (
          <ol className="divide-y divide-line overflow-hidden rounded-card border border-line">
            {view.factors.map((f, i) => (
              <li key={f.feature} className="flex items-center gap-3 px-4 py-3">
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular',
                    i === 0 ? 'bg-danger-soft text-danger' : 'bg-surface-sunken text-ink-muted',
                  )}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm text-ink">
                  {featureLabel(f.feature)}
                  {i === 0 && <span className="sr-only"> (largest effect)</span>}
                </span>
                <span className="shrink-0 text-sm font-medium tabular text-ink">{formatFactorValue(f.value, f.unit)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

/** A semicircle from 0 to 100, filled to the score in its band's colour, with a tick at the alert line (75). Grey when stale. */
function ScoreGauge({ score, band }: { score: number; band: HealthBand | null }) {
  // Draws in from empty once, on open: the panel's one moment of motion. Reduced motion shows it at once.
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(score))
    return () => cancelAnimationFrame(id)
  }, [score])
  const tick = (r: number) => {
    const angle = Math.PI * (1 - AT_RISK_BELOW / 100)
    return { x: 100 + r * Math.cos(angle), y: 100 - r * Math.sin(angle) }
  }
  const [inner, outer] = [tick(66), tick(94)]
  const arc = 'M 20 100 A 80 80 0 0 1 180 100'
  return (
    <figure className="flex flex-col items-center">
      <div className="relative w-full max-w-[280px]">
        <svg viewBox="0 0 200 112" className="w-full" role="img" aria-label={`Health score ${score} out of 100${band ? `, ${BAND_LABELS[band].toLowerCase()}` : ', stale'}`}>
          <path d={arc} pathLength={100} fill="none" strokeWidth={14} strokeLinecap="round" className="stroke-surface-sunken" />
          <path
            d={arc}
            pathLength={100}
            fill="none"
            strokeWidth={14}
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={`${shown} 100`}
            className={cn(
              band ? ARC_TONE[band] : 'text-neutral',
              'transition-[stroke-dasharray] duration-700 ease-out motion-reduce:transition-none',
            )}
          />
          <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} strokeWidth={2} strokeLinecap="round" className="stroke-ink-subtle" />
        </svg>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="text-5xl font-semibold tabular leading-none tracking-tight text-ink">{score}</span>
          <span className={cn('mt-2 text-sm font-medium', band ? ARC_TONE[band] : 'text-neutral')}>{band ? BAND_LABELS[band] : 'Stale'}</span>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-ink-subtle">Out of 100 · the tick marks {AT_RISK_BELOW}, below which a technician is alerted</figcaption>
    </figure>
  )
}

export function HealthSkeleton() {
  return (
    <div className="space-y-8" aria-hidden="true">
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="h-36 w-full max-w-[280px] rounded-card" />
        <Skeleton className="h-3 w-56" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-card" />
    </div>
  )
}
