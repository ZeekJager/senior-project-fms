import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartOptions,
  type TooltipItem,
} from 'chart.js'
import { useEffect, useMemo, useState } from 'react'
import { Bar, Line } from 'react-chartjs-2'
import { formatMinor } from '@/components/shared'
import type { FleetSummary, VehicleUtilisation } from './api'
import { birr, longDay, shortDay } from './describe'

// The S-18 charts (FMS-51), in Chart.js. One axis per chart; series colours are
// the validated tokens --c-series-1 and --c-series-2 (index.css), text wears ink tokens, grids stay recessive.
// Each chart has a table behind it for screen readers.

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Tooltip, Filler)

interface Theme {
  series1: string
  series2: string
  surface: string
  ink: string
  inkMuted: string
  line: string
}

const read = (name: string) => `rgb(${getComputedStyle(document.documentElement).getPropertyValue(name).trim()})`
const readTheme = (): Theme => ({
  series1: read('--c-series-1'),
  series2: read('--c-series-2'),
  surface: read('--c-surface'),
  ink: read('--c-ink'),
  inkMuted: read('--c-ink-subtle'),
  line: read('--c-line'),
})

/** The chart colours from the CSS tokens, read again when the theme changes (data-theme, or the OS setting). */
function useTheme(): Theme {
  const [theme, setTheme] = useState(readTheme)
  useEffect(() => {
    const update = () => setTheme(readTheme())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media?.removeEventListener('change', update)
    }
  }, [])
  return theme
}

/** What every chart shares: no animation (200 bars stay responsive), recessive axes, a tooltip in surface and ink. */
function base(t: Theme): ChartOptions<'bar' | 'line'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: t.surface,
        titleColor: t.ink,
        bodyColor: t.ink,
        borderColor: t.line,
        borderWidth: 1,
        padding: 10,
        boxPadding: 4,
        usePointStyle: true,
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: t.line }, ticks: { color: t.inkMuted, maxRotation: 0, autoSkipPadding: 16, font: { size: 11 } } },
      y: { beginAtZero: true, grid: { color: t.line }, border: { display: false }, ticks: { color: t.inkMuted, font: { size: 11 }, maxTicksLimit: 5 } },
    },
  }
}

/** A table of the chart's figures, for screen readers. */
function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
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
          <tr key={String(r[0])}>
            {r.map((c, i) => (
              <td key={i}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const pctText = (v: number | null) => (v === null ? '—' : `${v}%`)

/** A percentage axis that fits its data: a little headroom, in tens, never past 100 (a 7% fleet is not a flat line). */
export const pctAxisMax = (values: (number | null)[]) => Math.min(100, Math.max(10, Math.ceil((Math.max(0, ...values.map((v) => v ?? 0)) * 1.2) / 10) * 10))

/** Utilisation each day: the share of vehicles on a trip. One series, so the card's title names it. */
export function UtilisationByDayChart({ daily }: { daily: FleetSummary['daily'] }) {
  const t = useTheme()
  const data = useMemo(
    () => ({
      labels: daily.map((d) => shortDay(d.date)),
      datasets: [
        {
          label: 'Utilisation',
          data: daily.map((d) => d.utilisation_pct),
          borderColor: t.series1,
          backgroundColor: t.series1.replace(')', ' / 0.08)'),
          fill: true,
          borderWidth: 2,
          tension: 0.25,
          pointRadius: daily.length > 14 ? 0 : 3,
          pointHoverRadius: 5,
          pointBackgroundColor: t.series1,
          pointBorderColor: t.surface,
          pointBorderWidth: 2,
          spanGaps: false,
        },
      ],
    }),
    [daily, t],
  )
  const options = useMemo(() => {
    const o = base(t) as ChartOptions<'line'>
    o.scales!.y = { ...o.scales!.y, max: pctAxisMax(daily.map((d) => d.utilisation_pct)), ticks: { ...o.scales!.y!.ticks, callback: (v) => `${v}%` } }
    o.plugins!.tooltip!.callbacks = {
      title: (items) => longDay(daily[items[0].dataIndex]?.date ?? ''),
      label: (item: TooltipItem<'line'>) => {
        const d = daily[item.dataIndex]
        return ` ${pctText(d.utilisation_pct)} · ${d.vehicles_used} vehicles out · ${d.distance_km.toLocaleString()} km`
      },
    }
    return o
  }, [daily, t])
  return (
    <div className="relative h-64 flex-1 lg:min-h-64">
      <Line data={data} options={options} role="img" aria-label="Utilisation by day, line chart" />
      <DataTable caption="Utilisation by day" head={['Date', 'Utilisation', 'Vehicles out', 'Distance (km)']} rows={daily.map((d) => [d.date, pctText(d.utilisation_pct), d.vehicles_used, d.distance_km])} />
    </div>
  )
}

/** Cost each day, fuel below repairs, with a 2 px surface gap between them; the legend is the card's. */
export function CostByDayChart({ daily }: { daily: FleetSummary['daily'] }) {
  const t = useTheme()
  const data = useMemo(
    () => ({
      labels: daily.map((d) => shortDay(d.date)),
      datasets: [
        {
          label: 'Fuel',
          data: daily.map((d) => d.fuel_cost_cents),
          backgroundColor: t.series1,
          borderColor: t.surface,
          borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
          borderSkipped: false as const,
          stack: 'cost',
          maxBarThickness: 28,
        },
        {
          label: 'Repairs',
          data: daily.map((d) => d.maintenance_cost_cents),
          backgroundColor: t.series2,
          borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
          borderSkipped: false as const,
          stack: 'cost',
          maxBarThickness: 28,
        },
      ],
    }),
    [daily, t],
  )
  const options = useMemo(() => {
    const o = base(t) as ChartOptions<'bar'>
    o.scales!.x = { ...o.scales!.x, stacked: true }
    o.scales!.y = { ...o.scales!.y, stacked: true, ticks: { ...o.scales!.y!.ticks, callback: (v) => formatMinor(Number(v), 2, 0) } }
    o.plugins!.tooltip!.callbacks = {
      title: (items) => longDay(daily[items[0].dataIndex]?.date ?? ''),
      label: (item: TooltipItem<'bar'>) => ` ${item.dataset.label}: ${birr(Number(item.raw))}`,
      footer: (items) => `Total: ${birr(daily[items[0].dataIndex]?.total_cost_cents ?? 0)}`,
    }
    return o
  }, [daily, t])
  return (
    <div className="relative h-64">
      <Bar data={data} options={options} role="img" aria-label="Cost by day, fuel and repairs, stacked bar chart" />
      <DataTable
        caption="Cost by day"
        head={['Date', 'Fuel', 'Repairs', 'Total']}
        rows={daily.map((d) => [d.date, birr(d.fuel_cost_cents), birr(d.maintenance_cost_cents), birr(d.total_cost_cents)])}
      />
    </div>
  )
}

/** Each vehicle's utilisation over the range, highest first; up to the whole fleet (200 bars), plates in the tooltip. */
export function UtilisationByVehicleChart({ vehicles }: { vehicles: VehicleUtilisation[] }) {
  const t = useTheme()
  const many = vehicles.length > 40
  const data = useMemo(
    () => ({
      labels: vehicles.map((v) => v.registration_number),
      datasets: [
        {
          label: 'Utilisation',
          data: vehicles.map((v) => v.utilisation_pct ?? 0),
          backgroundColor: t.series1,
          borderRadius: many ? 2 : 4,
          borderSkipped: 'bottom' as const,
          categoryPercentage: 0.9,
          barPercentage: many ? 1 : 0.8,
          maxBarThickness: 24,
        },
      ],
    }),
    [vehicles, t, many],
  )
  const options = useMemo(() => {
    const o = base(t) as ChartOptions<'bar'>
    o.interaction = { mode: 'nearest', axis: 'x', intersect: false }
    o.scales!.x = { ...o.scales!.x, ticks: { ...o.scales!.x!.ticks, display: !many } }
    o.scales!.y = { ...o.scales!.y, max: pctAxisMax(vehicles.map((v) => v.utilisation_pct)), ticks: { ...o.scales!.y!.ticks, callback: (v) => `${v}%` } }
    o.plugins!.tooltip!.callbacks = {
      title: (items) => vehicles[items[0].dataIndex]?.registration_number ?? '',
      label: (item: TooltipItem<'bar'>) => {
        const v = vehicles[item.dataIndex]
        return ` ${pctText(v.utilisation_pct)} · on the road ${v.days_used} of ${v.days} days · ${v.distance_km.toLocaleString()} km`
      },
      afterLabel: (item: TooltipItem<'bar'>) => ` ${vehicles[item.dataIndex].depot_name}`,
    }
    return o
  }, [vehicles, t, many])
  return (
    <div className="relative h-64">
      <Bar data={data} options={options} role="img" aria-label={`Utilisation by vehicle, ${vehicles.length} vehicles, bar chart`} />
      <DataTable
        caption="Utilisation by vehicle"
        head={['Vehicle', 'Depot', 'Utilisation', 'Days on the road', 'Distance (km)']}
        rows={vehicles.map((v) => [v.registration_number, v.depot_name, pctText(v.utilisation_pct), `${v.days_used} of ${v.days}`, v.distance_km])}
      />
    </div>
  )
}
