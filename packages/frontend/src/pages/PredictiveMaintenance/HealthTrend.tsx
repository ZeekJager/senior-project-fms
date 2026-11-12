import { CalendarRange, LineChart } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { EmptyState, ErrorState } from '@/components/shared'
import { Card, FilterSelect, Skeleton } from '@/components/ui'
import { longDay } from '@/pages/Analytics/describe'
import { TREND_RANGES, useHealthTrend, type HealthTrendDay, type TrendRange } from './api'
import { HighRiskShareChart, MeanHealthChart } from './HealthTrendCharts'

const RANGE_LABELS: Record<TrendRange, string> = { 30: 'Last 30 days', 90: 'Last 90 days', 180: 'Last 6 months', 365: 'Last 12 months' }

function Panel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col p-4 sm:p-5">
      <div className="mb-4 min-w-0">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>
      </div>
      {children}
    </Card>
  )
}

/** The first and last scored days of the range: what the line says, in a sentence beside it. */
function change(days: HealthTrendDay[]): string | null {
  const scored = days.filter((d) => d.mean_health_score !== null)
  if (scored.length < 2) return null
  const first = scored[0].mean_health_score!
  const last = scored[scored.length - 1].mean_health_score!
  const delta = Math.round((last - first) * 10) / 10
  if (delta === 0) return `Unchanged at ${last} over the range`
  return `${delta > 0 ? 'Up' : 'Down'} ${Math.abs(delta)} points, from ${first} to ${last}`
}

/**
 * The fleet-wide health trend on S-19 (FMS-150): how the average health score of the depot's (or every) vehicle has
 * moved, and the share in the high-risk band, from the scores stored each night. analytics:read, besides the page's
 * prediction:read. Follows the page's depot filter; the range is its own (90 days by default).
 */
export function HealthTrend({ depotId, depotName }: { depotId: string; depotName: string | null }) {
  const [days, setDays] = useState<TrendRange>(90)
  const trend = useHealthTrend(days, depotId, true)
  const data = trend.data
  const scoredDays = data?.filter((d) => d.mean_health_score !== null).length ?? 0
  const summary = data ? change(data) : null
  const latest = data?.filter((d) => d.mean_health_score !== null).at(-1)

  return (
    <section aria-labelledby="health-trend-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="health-trend-heading" className="text-base font-semibold text-ink">
            Fleet health trend
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {depotName ? `${depotName}: ` : ''}
            {summary ?? 'How the average health score has moved, from each night’s scoring'}
          </p>
        </div>
        <FilterSelect
          label="Range"
          icon={<CalendarRange />}
          value={String(days)}
          onChange={(v) => setDays(Number(v) as TrendRange)}
          options={TREND_RANGES.map((r) => ({ value: String(r), label: RANGE_LABELS[r] }))}
        />
      </div>

      {trend.isError && !data ? (
        <Card>
          <ErrorState error={trend.error} onRetry={() => void trend.refetch()} />
        </Card>
      ) : data && scoredDays === 0 ? (
        <Card>
          <EmptyState
            icon={<LineChart />}
            heading="No scores in this range"
            description="The trend draws itself from the nightly scoring at 02:00. No night in this range scored a vehicle here."
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Average health score"
            description={latest ? `Last scored ${longDay(latest.date)}: ${latest.mean_health_score} across ${latest.vehicles_scored} vehicles. 0 to 100; higher is healthier.` : '0 to 100; higher is healthier.'}
          >
            {data ? <MeanHealthChart days={data} /> : <Skeleton className="h-56 w-full" />}
          </Panel>
          <Panel title="Share at high risk" description="Vehicles scored 40 or less, of those scored that night. A gap is a night with no scoring run.">
            {data ? <HighRiskShareChart days={data} /> : <Skeleton className="h-56 w-full" />}
          </Panel>
        </div>
      )}
    </section>
  )
}
