import { CategoryScale, Chart as ChartJS, Filler, LinearScale, LineElement, PointElement, Tooltip, type ChartOptions, type TooltipItem } from 'chart.js'
import { useMemo } from 'react'
import { Line } from 'react-chartjs-2'
import { baseChartOptions, useChartTheme, type ChartTheme } from '@/lib/chartTheme'
import { longDay, shortDay } from '@/pages/Analytics/describe'
import type { HealthTrendDay } from './api'

// The fleet-wide health score trend on S-19 (FMS-150), in Chart.js: the daily mean score, and the share of vehicles
// in the high-risk band as a chart of its own (one axis per chart). A day with no scoring run is a gap in the line,
// never a zero. Each chart has a table behind it for screen readers.

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Filler)

const scoreText = (v: number | null) => (v === null ? 'No scoring run' : v.toLocaleString('en-US', { maximumFractionDigits: 1 }))
const pctText = (v: number | null) => (v === null ? 'No scoring run' : `${v}%`)

function lineOf(t: ChartTheme, color: string, values: (number | null)[], fill: boolean) {
  return {
    data: values,
    borderColor: color,
    backgroundColor: color.replace(')', ' / 0.08)'),
    fill,
    borderWidth: 2,
    tension: 0.25,
    // Few days: every point shows, so a lone night between gaps is still seen.
    pointRadius: values.length > 31 ? 0 : 3,
    pointHoverRadius: 5,
    pointBackgroundColor: color,
    pointBorderColor: t.surface,
    pointBorderWidth: 2,
    spanGaps: false,
  }
}

function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[0]}>
            {r.map((c, i) => (
              <td key={i}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The fleet's mean health score each day (0 to 100; the axis fits the scores). */
export function MeanHealthChart({ days }: { days: HealthTrendDay[] }) {
  const t = useChartTheme()
  const data = useMemo(
    () => ({ labels: days.map((d) => shortDay(d.date)), datasets: [{ label: 'Average health score', ...lineOf(t, t.series1, days.map((d) => d.mean_health_score), false) }] }),
    [days, t],
  )
  const options = useMemo(() => {
    const o = baseChartOptions(t) as ChartOptions<'line'>
    // Fitted to the scores, in tens like its gridlines, so a slide from 78 to 70 is seen; no area fill, since the axis
    // does not start at 0.
    const scores = days.flatMap((d) => (d.mean_health_score === null ? [] : [d.mean_health_score]))
    const low = scores.length ? Math.max(0, Math.floor((Math.min(...scores) - 2) / 10) * 10) : 0
    const high = scores.length ? Math.min(100, Math.ceil((Math.max(...scores) + 2) / 10) * 10) : 100
    o.scales!.y = { ...o.scales!.y, beginAtZero: false, min: low, max: high }
    o.plugins!.tooltip!.callbacks = {
      title: (items) => longDay(days[items[0].dataIndex]?.date ?? ''),
      label: (item: TooltipItem<'line'>) => {
        const d = days[item.dataIndex]
        return d.mean_health_score === null ? ' No scoring run' : ` Average ${scoreText(d.mean_health_score)} · ${d.vehicles_scored} vehicles scored`
      },
    }
    return o
  }, [days, t])
  return (
    <div className="relative h-56">
      <Line data={data} options={options} role="img" aria-label="Average health score by day, line chart" />
      <SrTable
        caption="Average health score by day"
        head={['Date', 'Average health score', 'Vehicles scored']}
        rows={days.map((d) => [d.date, scoreText(d.mean_health_score), d.vehicles_scored === null ? '—' : String(d.vehicles_scored)])}
      />
    </div>
  )
}

/** The share of vehicles scored each day that were in the high-risk band. */
export function HighRiskShareChart({ days }: { days: HealthTrendDay[] }) {
  const t = useChartTheme()
  const data = useMemo(
    () => ({ labels: days.map((d) => shortDay(d.date)), datasets: [{ label: 'High risk', ...lineOf(t, t.series2, days.map((d) => d.high_risk_pct), true) }] }),
    [days, t],
  )
  const options = useMemo(() => {
    const o = baseChartOptions(t) as ChartOptions<'line'>
    // A small share is not drawn as a flat line along the floor: headroom in tens, never past 100.
    const top = Math.min(100, Math.max(10, Math.ceil((Math.max(0, ...days.map((d) => d.high_risk_pct ?? 0)) * 1.2) / 10) * 10))
    o.scales!.y = { ...o.scales!.y, min: 0, max: top, ticks: { ...o.scales!.y!.ticks, callback: (v) => `${v}%` } }
    o.plugins!.tooltip!.callbacks = {
      title: (items) => longDay(days[items[0].dataIndex]?.date ?? ''),
      label: (item: TooltipItem<'line'>) => {
        const d = days[item.dataIndex]
        if (d.high_risk_pct === null || d.vehicles_scored === null) return ' No scoring run'
        return ` ${pctText(d.high_risk_pct)} high risk · ${Math.round((d.high_risk_pct * d.vehicles_scored) / 100)} of ${d.vehicles_scored} vehicles`
      },
    }
    return o
  }, [days, t])
  return (
    <div className="relative h-56">
      <Line data={data} options={options} role="img" aria-label="Share of vehicles at high risk by day, line chart" />
      <SrTable caption="Share of vehicles at high risk by day" head={['Date', 'High risk']} rows={days.map((d) => [d.date, pctText(d.high_risk_pct)])} />
    </div>
  )
}
