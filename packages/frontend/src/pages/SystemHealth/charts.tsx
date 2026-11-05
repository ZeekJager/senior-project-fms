import { CategoryScale, Chart as ChartJS, Filler, LinearScale, LineElement, PointElement, Tooltip, type ChartOptions, type TooltipItem } from 'chart.js'
import { useMemo } from 'react'
import { Line } from 'react-chartjs-2'
import { baseChartOptions, useChartTheme } from '@/lib/chartTheme'
import type { SystemHealthHistory } from './api'
import { cellLabel, cellRange, milliseconds, percentText } from './describe'

// The S-31 charts (FMS-143): the API's 5xx share and its p95 latency per cell of the window. One series and one
// axis each (two measures, two charts), the series colour --c-series-1, a table behind each for screen readers.

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Filler)

type Cell = SystemHealthHistory['requests']['cells'][number]

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

function SeriesChart({
  cells,
  bucketMinutes,
  value,
  axis,
  tooltip,
  label,
  table,
}: {
  cells: Cell[]
  bucketMinutes: number
  value: (c: Cell) => number | null
  axis: (v: number) => string
  tooltip: (c: Cell) => string
  label: string
  table: { caption: string; head: string[]; row: (c: Cell) => string[] }
}) {
  const t = useChartTheme()
  const data = useMemo(
    () => ({
      labels: cells.map((c) => cellLabel(c.start, bucketMinutes)),
      datasets: [
        {
          label,
          data: cells.map(value),
          borderColor: t.series1,
          backgroundColor: t.series1.replace(')', ' / 0.08)'),
          fill: true,
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointBackgroundColor: t.series1,
          pointBorderColor: t.surface,
          pointBorderWidth: 2,
          // A cell with no requests has no rate or latency: a gap, not a zero.
          spanGaps: false,
        },
      ],
    }),
    [cells, bucketMinutes, value, label, t],
  )
  const options = useMemo(() => {
    const o = baseChartOptions(t) as ChartOptions<'line'>
    o.scales!.y = { ...o.scales!.y, ticks: { ...o.scales!.y!.ticks, callback: (v) => axis(Number(v)) } }
    o.plugins!.tooltip!.callbacks = {
      title: (items) => cellRange(cells[items[0].dataIndex]?.start ?? '', bucketMinutes),
      label: (item: TooltipItem<'line'>) => ` ${tooltip(cells[item.dataIndex])}`,
    }
    return o
  }, [cells, bucketMinutes, axis, tooltip, t])
  return (
    <div className="relative h-56">
      <Line data={data} options={options} role="img" aria-label={`${label} over time, line chart`} />
      <SrTable caption={table.caption} head={table.head} rows={cells.filter((c) => c.requests > 0).map(table.row)} />
    </div>
  )
}

const rate = (c: Cell) => c.error_rate_pct
const p95 = (c: Cell) => c.p95_ms
const pctAxis = (v: number) => `${v}%`
const msAxis = (v: number) => milliseconds(v)
const rateTip = (c: Cell) => (c.requests === 0 ? 'No requests' : `${percentText(c.error_rate_pct)} · ${c.errors_5xx.toLocaleString()} of ${c.requests.toLocaleString()} requests`)
const latencyTip = (c: Cell) => (c.requests === 0 ? 'No requests' : `p95 ${milliseconds(c.p95_ms)} · ${c.requests.toLocaleString()} requests`)

/** The share of requests answered with a 5xx, per cell. */
export function ErrorRateChart({ cells, bucketMinutes }: { cells: Cell[]; bucketMinutes: number }) {
  return (
    <SeriesChart
      cells={cells}
      bucketMinutes={bucketMinutes}
      value={rate}
      axis={pctAxis}
      tooltip={rateTip}
      label="Error rate"
      table={{ caption: 'Error rate by period', head: ['From', 'Requests', '5xx errors', 'Error rate'], row: (c) => [c.start, String(c.requests), String(c.errors_5xx), percentText(c.error_rate_pct)] }}
    />
  )
}

/** The 95th percentile of the time to answer, per cell. */
export function LatencyChart({ cells, bucketMinutes }: { cells: Cell[]; bucketMinutes: number }) {
  return (
    <SeriesChart
      cells={cells}
      bucketMinutes={bucketMinutes}
      value={p95}
      axis={msAxis}
      tooltip={latencyTip}
      label="p95 latency"
      table={{ caption: 'p95 latency by period', head: ['From', 'Requests', 'p95 latency'], row: (c) => [c.start, String(c.requests), milliseconds(c.p95_ms)] }}
    />
  )
}
