import { BarElement, CategoryScale, Chart as ChartJS, Filler, LinearScale, LineElement, PointElement, Tooltip, type ChartOptions, type TooltipItem } from 'chart.js'
import { useMemo } from 'react'
import { Bar, Line } from 'react-chartjs-2'
import { baseChartOptions as base, useChartTheme as useTheme } from '@/lib/chartTheme'
import { monthLabel } from '@/lib/month'
import { formatKpi, type KpiTrend, type KpiUnit } from './api'

// The KPI dashboard's charts (FMS-160), on the S-18 Chart.js setup: series colours from the validated tokens, recessive
// axes, ink text, a table behind each for screen readers.

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Tooltip, Filler)

const shortMonth = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })

/** The value an axis or tooltip reads, without the unit's prefix where the axis is crowded. */
const axisValue = (unit: KpiUnit, v: number) => (unit === 'cents_per_km' ? (v / 100).toFixed(2) : unit === 'tenths_l_per_100km' || unit === 'tenths_per_100k_km' ? (v / 10).toFixed(1) : unit === 'pct' ? `${v}%` : String(v))

/** Twelve months as a thin line, no axes: the shape, not the figures (the tile says those). */
export function Sparkline({ points, unit, label }: { points: [string, number | null][]; unit: KpiUnit; label: string }) {
  const t = useTheme()
  const data = useMemo(
    () => ({
      labels: points.map(([m]) => m),
      datasets: [{ data: points.map(([, v]) => v), borderColor: t.series1, borderWidth: 2, tension: 0.3, pointRadius: 0, pointHoverRadius: 3, spanGaps: true, fill: false }],
    }),
    [points, t],
  )
  const options = useMemo(() => {
    const o = base(t) as ChartOptions<'line'>
    o.scales = { x: { display: false }, y: { display: false } }
    o.layout = { padding: 2 }
    o.plugins!.tooltip!.callbacks = {
      title: (items) => monthLabel(points[items[0].dataIndex]?.[0] ?? ''),
      label: (item: TooltipItem<'line'>) => ` ${formatKpi(unit, item.raw as number | null)}`,
    }
    return o
  }, [points, t, unit])
  const known = points.filter(([, v]) => v !== null)
  const summary = known.length ? `${label}, last 12 months: from ${formatKpi(unit, known[0][1])} in ${monthLabel(known[0][0])} to ${formatKpi(unit, known.at(-1)![1])} in ${monthLabel(known.at(-1)![0])}` : `${label}: no figures in the last 12 months`
  return (
    <div className="relative h-10 w-full">
      <Line data={data} options={options} role="img" aria-label={summary} />
    </div>
  )
}

/** The KPI month by month, last year beside it (dashed, the second series), with a legend. */
export function TrendChart({ trend }: { trend: KpiTrend }) {
  const t = useTheme()
  const data = useMemo(
    () => ({
      labels: trend.series.map((s) => shortMonth(s.month)),
      datasets: [
        { label: 'This period', data: trend.series.map((s) => s.value), borderColor: t.series1, backgroundColor: t.series1, borderWidth: 2, tension: 0.25, pointRadius: 3, pointBackgroundColor: t.series1, pointBorderColor: t.surface, pointBorderWidth: 2, spanGaps: true },
        { label: 'A year before', data: trend.series.map((s) => s.last_year), borderColor: t.series2, backgroundColor: t.series2, borderWidth: 2, borderDash: [5, 4], tension: 0.25, pointRadius: 2, pointBackgroundColor: t.series2, spanGaps: true },
      ],
    }),
    [trend, t],
  )
  const options = useMemo(() => {
    const o = base(t) as ChartOptions<'line'>
    o.scales!.y = { ...o.scales!.y, ticks: { ...o.scales!.y!.ticks, callback: (v) => axisValue(trend.unit, Number(v)) } }
    o.plugins!.tooltip!.callbacks = {
      title: (items) => monthLabel(trend.series[items[0].dataIndex]?.month ?? ''),
      label: (item: TooltipItem<'line'>) => ` ${item.dataset.label}: ${formatKpi(trend.unit, item.raw as number | null)}`,
    }
    return o
  }, [trend, t])
  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-4 text-xs text-ink-muted" aria-hidden="true">
        <li className="flex items-center gap-2">
          <span className="h-0.5 w-5 rounded-full" style={{ background: t.series1 }} /> This period
        </li>
        <li className="flex items-center gap-2">
          <span className="h-0 w-5 border-t-2 border-dashed" style={{ borderColor: t.series2 }} /> A year before
        </li>
      </ul>
      <div className="relative h-64">
        <Line data={data} options={options} role="img" aria-label={`${trend.label} by month, this period and a year before, line chart`} />
        <table className="sr-only">
          <caption>{trend.label} by month</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Value</th>
              <th scope="col">A year before</th>
            </tr>
          </thead>
          <tbody>
            {trend.series.map((s) => (
              <tr key={s.month}>
                <td>{monthLabel(s.month)}</td>
                <td>{formatKpi(trend.unit, s.value)}</td>
                <td>{formatKpi(trend.unit, s.last_year)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** The KPI per depot or vehicle, a horizontal bar each, highest first. */
export function BreakdownChart({ trend, onPick }: { trend: KpiTrend; onPick?: (name: string) => void }) {
  const t = useTheme()
  const items = useMemo(() => [...trend.breakdown].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity)).slice(0, 30), [trend.breakdown])
  const data = useMemo(
    () => ({
      labels: items.map((i) => i.name),
      datasets: [{ label: trend.label, data: items.map((i) => i.value), backgroundColor: t.series1, borderRadius: 4, borderSkipped: 'start' as const, maxBarThickness: 18, categoryPercentage: 0.8, barPercentage: 0.9 }],
    }),
    [items, t, trend.label],
  )
  const options = useMemo(() => {
    const o = base(t) as ChartOptions<'bar'>
    o.indexAxis = 'y'
    o.interaction = { mode: 'nearest', axis: 'y', intersect: false }
    o.scales = {
      x: { grid: { color: t.line }, border: { display: false }, ticks: { color: t.inkMuted, font: { size: 11 }, callback: (v) => axisValue(trend.unit, Number(v)) } },
      y: { grid: { display: false }, border: { color: t.line }, ticks: { color: t.ink, font: { size: 12 }, autoSkip: false } },
    }
    o.plugins!.tooltip!.callbacks = { label: (item: TooltipItem<'bar'>) => ` ${formatKpi(trend.unit, item.raw as number | null)}` }
    o.onClick = (_e, elements) => {
      const i = elements[0]?.index
      if (i !== undefined && onPick) onPick(items[i].name)
    }
    return o
  }, [t, trend.unit, items, onPick])
  return (
    <div className="relative" style={{ height: Math.max(96, items.length * 28 + 32) }}>
      <Bar data={data} options={options} role="img" aria-label={`${trend.label} by ${trend.group ?? 'depot'}, bar chart`} />
    </div>
  )
}
