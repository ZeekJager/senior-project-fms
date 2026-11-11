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
  type Plugin,
  type TooltipItem,
} from 'chart.js'
import { useMemo } from 'react'
import { Bar, Line } from 'react-chartjs-2'
import { formatMinor } from '@/components/shared'
import { baseChartOptions as base, useChartTheme as useTheme } from '@/lib/chartTheme'
import type { FleetSummary, RankedDriver, ScoreComponent, VehicleUtilisation } from './api'
import { birr, longDay, shortDay } from './describe'

// The S-18 charts (FMS-51), in Chart.js. One axis per chart; series colours are
// the validated tokens --c-series-1 and --c-series-2 (index.css), text wears ink tokens, grids stay recessive
// (lib/chartTheme). Each chart has a table behind it for screen readers.

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Tooltip, Filler)

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
        {rows.map((r, i) => (
          <tr key={`${i}:${String(r[0])}`}>
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

export const COMPONENT_WORDS: Record<ScoreComponent, string> = { punctuality: 'Punctuality', safety: 'Safety', incidents: 'Incidents', dvir: 'Inspections' }

/** Each part of a driver's score, for a tooltip or a table: "Punctuality 50 · Safety 80 · …", "—" for one not judged. */
export const componentsText = (c: RankedDriver['components']) =>
  (Object.keys(COMPONENT_WORDS) as ScoreComponent[]).map((k) => `${COMPONENT_WORDS[k]} ${c[k] ?? '—'}`).join(' · ')

/** The score at the end of each bar, in ink: the value is read without hovering. */
const scoreLabels = (ink: string): Plugin<'bar'> => ({
  id: 'scoreLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart
    const meta = chart.getDatasetMeta(0)
    ctx.save()
    ctx.fillStyle = ink
    ctx.font = '600 11px Inter, system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    meta.data.forEach((bar, i) => {
      const value = chart.data.datasets[0].data[i]
      ctx.fillText(String(value), bar.x + 6, bar.y)
    })
    ctx.restore()
  },
})

/**
 * Drivers ranked by their monthly score (FMS-146), a horizontal bar each on a 0 to 100 axis, highest at the top, with the
 * score at the end of the bar and its parts in the tooltip. One series, so the panel's heading names it. `nameLength`
 * cuts a long name: Chart.js gives the names at most a third of the chart, and a half-width chart has less room.
 */
export function DriverRankingChart({ drivers, label, nameLength = 24 }: { drivers: RankedDriver[]; label: string; nameLength?: number }) {
  const t = useTheme()
  const data = useMemo(
    () => ({
      labels: drivers.map((d) => `${d.rank}. ${d.name}`),
      datasets: [
        {
          label: 'Score',
          data: drivers.map((d) => d.score),
          backgroundColor: t.series1,
          borderRadius: 4,
          borderSkipped: 'start' as const,
          categoryPercentage: 0.8,
          barPercentage: 0.9,
          maxBarThickness: 18,
        },
      ],
    }),
    [drivers, t],
  )
  const options = useMemo(() => {
    const o = base(t) as ChartOptions<'bar'>
    o.indexAxis = 'y'
    o.interaction = { mode: 'nearest', axis: 'y', intersect: false }
    // Room after the longest bar for its score.
    o.layout = { padding: { right: 28 } }
    o.scales = {
      x: { min: 0, max: 100, grid: { color: t.line }, border: { display: false }, ticks: { color: t.inkMuted, font: { size: 11 }, stepSize: 25 } },
      y: {
        grid: { display: false },
        border: { color: t.line },
        ticks: {
          color: t.ink,
          font: { size: 12 },
          autoSkip: false,
          // A long name is cut: the tooltip and the table behind the chart give it whole.
          callback(value) {
            const text = String(this.getLabelForValue(Number(value)))
            return text.length > nameLength ? `${text.slice(0, nameLength - 1)}…` : text
          },
        },
      },
    }
    o.plugins!.tooltip!.callbacks = {
      title: (items) => {
        const d = drivers[items[0].dataIndex]
        return d ? `${d.rank}. ${d.name}` : ''
      },
      label: (item: TooltipItem<'bar'>) => ` Score ${drivers[item.dataIndex].score} · ${drivers[item.dataIndex].trips_completed} trips · ${drivers[item.dataIndex].depot}`,
      afterLabel: (item: TooltipItem<'bar'>) => ` ${componentsText(drivers[item.dataIndex].components)}`,
    }
    return o
  }, [drivers, t, nameLength])
  const plugins = useMemo(() => [scoreLabels(t.ink)], [t.ink])
  return (
    <div className="relative" style={{ height: Math.max(96, drivers.length * 26 + 32) }}>
      <Bar data={data} options={options} plugins={plugins} role="img" aria-label={`${label}, ${drivers.length} drivers, bar chart`} />
      <DataTable
        caption={label}
        head={['Rank', 'Driver', 'Depot', 'Score', 'Parts', 'Trips']}
        rows={drivers.map((d) => [d.rank, d.name, d.depot, d.score, componentsText(d.components), d.trips_completed])}
      />
    </div>
  )
}
