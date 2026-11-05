import type { ChartOptions } from 'chart.js'
import { useEffect, useState } from 'react'

// What the Chart.js charts share (S-18, S-31): colours from the CSS tokens, recessive axes, a tooltip in surface
// and ink. Series colours are the validated tokens --c-series-1 and --c-series-2 (index.css).

export interface ChartTheme {
  series1: string
  series2: string
  surface: string
  ink: string
  inkMuted: string
  line: string
}

const read = (name: string) => `rgb(${getComputedStyle(document.documentElement).getPropertyValue(name).trim()})`
const readTheme = (): ChartTheme => ({
  series1: read('--c-series-1'),
  series2: read('--c-series-2'),
  surface: read('--c-surface'),
  ink: read('--c-ink'),
  inkMuted: read('--c-ink-subtle'),
  line: read('--c-line'),
})

/** The chart colours from the CSS tokens, read again when the theme changes (data-theme, or the OS setting). */
export function useChartTheme(): ChartTheme {
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
export function baseChartOptions(t: ChartTheme): ChartOptions<'bar' | 'line'> {
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
