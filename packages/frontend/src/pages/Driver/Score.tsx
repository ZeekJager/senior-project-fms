import { AlertCircle, Trophy } from 'lucide-react'
import { useState } from 'react'
import { MonthStepper } from '@/components/shared'
import { Skeleton, cn } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { currentMonth, monthLabel, shiftMonth, type Month } from '@/lib/month'
import { useMyPerformance, type MyPerformance } from './api'
import { FormHeader, Panel } from './parts'

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const km = (metres: number) => `${Math.round(metres / 1000).toLocaleString()} km`

type Part = keyof MyPerformance['components']

const PARTS: { key: Part; label: string; what: (p: MyPerformance) => string; notJudged: string }[] = [
  {
    key: 'punctuality',
    label: 'On time',
    what: (p) => `${p.components.punctuality.trips_on_time} of ${count(p.components.punctuality.trips_timed, 'trip')} ended within 15 minutes of the schedule.`,
    notJudged: 'No trip had a scheduled end.',
  },
  {
    key: 'safety',
    label: 'Safe driving',
    what: (p) => `${count(p.components.safety.speeding, 'speeding alert')} and ${count(p.components.safety.idling, 'idling alert')} over ${km(p.distance_m)}.`,
    notJudged: 'Judged from 10 km driven.',
  },
  {
    key: 'incidents',
    label: 'No accidents',
    what: (p) => (p.components.incidents.accidents === 0 ? `No accident over ${km(p.distance_m)}.` : `${count(p.components.incidents.accidents, 'accident')} over ${km(p.distance_m)}.`),
    notJudged: 'Judged from 10 km driven.',
  },
  {
    key: 'dvir',
    label: 'Inspections',
    what: (p) => `${p.components.dvir.trips_inspected} of ${count(p.trips_completed, 'trip')} inspected before setting off.`,
    notJudged: 'No trip completed.',
  },
]

/** A score from 0 to 100 as a bar. */
function Meter({ value, label }: { value: number; label: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
      <div className="h-full rounded-full bg-brand" style={{ width: `${value}%` }} />
    </div>
  )
}

function Parts({ p }: { p: MyPerformance }) {
  const total = PARTS.reduce((sum, part) => sum + p.components[part.key].weight, 0)
  return (
    <section aria-labelledby="parts-heading" className="rounded-card border border-line bg-surface shadow-card">
      <h2 id="parts-heading" className="border-b border-line px-5 py-3 text-sm font-semibold uppercase tracking-wider text-ink-subtle">
        What makes it up
      </h2>
      <ul className="divide-y divide-line">
        {PARTS.map((part) => {
          const c = p.components[part.key]
          const share = total > 0 ? Math.round((c.weight * 100) / total) : 0
          return (
            <li key={part.key} className="space-y-2 px-5 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-base font-semibold text-ink">{part.label}</span>
                <span className={cn('tabular text-lg font-semibold', c.score === null ? 'text-ink-subtle' : 'text-ink')}>{c.score === null ? '—' : c.score}</span>
              </div>
              {c.score !== null && <Meter value={c.score} label={`${part.label}, ${c.score} out of 100`} />}
              <p className="text-sm text-ink-muted">{c.score === null ? part.notJudged : part.what(p)}</p>
              <p className="text-xs text-ink-subtle">{c.weight === 0 ? 'Not counted in the score this month.' : `Counts for ${share}% of the score.`}</p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * My score (FMS-146): the driver's own performance score for a month, from 0 to 100, and the four parts it is made of,
 * each with what it was worked out from. Only their own: no other driver's, and no ranking.
 */
export function DriverScore() {
  const [month, setMonth] = useState<Month>(() => shiftMonth(currentMonth(), -1))
  const me = useMyPerformance(month)
  const p = me.data

  return (
    <div className="space-y-5">
      <FormHeader title="My score" />
      <div className="flex justify-center">
        <MonthStepper month={month} onChange={setMonth} />
      </div>

      {/* A failed refresh keeps the score already shown: no signal in the cab is no reason to hide it. */}
      {!p && me.isError && me.error instanceof ApiError && me.error.status === 404 ? (
        <Panel icon={<Trophy />} title="Only drivers have a score" tone="neutral">
          Drivers&rsquo; scores are in the driver performance report.
        </Panel>
      ) : !p && me.isError ? (
        <Panel icon={<AlertCircle />} title="Your score could not be loaded" tone="danger">
          Check your signal and try again.
        </Panel>
      ) : !p ? (
        <Skeleton className="h-64 w-full rounded-card" />
      ) : (
        <>
          {p.score === null ? (
            <Panel icon={<Trophy />} title={`No score for ${monthLabel(month)}`} tone="neutral">
              {p.reason === 'not_enough_trips'
                ? `A score needs ${p.min_trips} completed trips in the month. You completed ${p.trips_completed}.`
                : 'There was nothing to score this month.'}
            </Panel>
          ) : (
            <section aria-label={`Your score for ${monthLabel(month)}`} className="flex flex-col items-center rounded-card border border-line bg-surface px-6 py-8 text-center shadow-card">
              <p className="text-sm font-medium text-ink-muted">{monthLabel(month)}</p>
              <p className="mt-2 flex items-baseline gap-1.5">
                <span className="tabular text-6xl font-semibold tracking-tight text-ink">{p.score}</span>
                <span className="text-lg text-ink-muted">out of 100</span>
              </p>
              <p className="mt-2 text-sm text-ink-muted">
                {count(p.trips_completed, 'trip')} · {km(p.distance_m)}
              </p>
            </section>
          )}
          {p.trips_completed > 0 && <Parts p={p} />}
          <p className="text-center text-xs text-ink-subtle">Only you and your managers see your score.</p>
        </>
      )}
    </div>
  )
}
