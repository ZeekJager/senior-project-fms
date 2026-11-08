import { matchPath } from 'react-router-dom'
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals'
import { API_BASE } from '@/lib/api/client'

/** Where the reports go (FMS-75, docs/metrics.md): any signed-in user; recorded as histograms, nothing about the user kept. */
export const WEB_VITALS_URL = `${API_BASE}/telemetry/web-vitals`

/** The API takes at most this many reports a request. */
export const MAX_REPORTS_PER_REQUEST = 10

export interface WebVitalReport {
  name: Metric['name']
  /** Milliseconds for the times; CLS is a score. */
  value: number
  rating: Metric['rating']
  /** The route template of the page, such as `/vehicles/:vehicleId`; never the URL. */
  page?: string
}

/**
 * The route template a path matches (`/vehicles/3f2b…` → `/vehicles/:vehicleId`), or undefined for a path no route has (a 404, the
 * login page): ids and query strings must never leave the browser in a label.
 */
export function pageTemplate(pathname: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => matchPath({ path: pattern, end: true }, pathname) !== null)
}

/** A browser metric as the API takes it. The value is rounded to 3 decimals: more is noise, and keeps the body small. */
export function toReport(metric: Pick<Metric, 'name' | 'value' | 'rating'>, page?: string): WebVitalReport {
  return { name: metric.name, value: Math.round(metric.value * 1000) / 1000, rating: metric.rating, ...(page ? { page } : {}) }
}

/** The request body for some reports. */
export const bodyOf = (reports: readonly WebVitalReport[]): string => JSON.stringify({ metrics: reports })

/**
 * Sends a body as the page closes. `sendBeacon` is made for that: it survives the page going away and carries the session
 * cookie. Where it is missing or refuses (a full queue), a `keepalive` fetch does the same. A failure is dropped: a lost report
 * is a gap in a graph, not a reason to bother the user.
 */
export function sendBody(body: string): boolean {
  try {
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(WEB_VITALS_URL, new Blob([body], { type: 'application/json' }))) return true
    void fetch(WEB_VITALS_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true, credentials: 'same-origin' }).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

export interface StartOptions {
  /** The page the user is on now, as a route template. Read when a metric arrives, so a metric belongs to the page it was reported on. */
  page: () => string | undefined
  send?: (body: string) => boolean
  /** The subscriptions to the browser's metrics, replaceable in tests. */
  observers?: readonly ((report: (metric: Metric) => void) => void)[]
  target?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

const BROWSER_OBSERVERS = [onLCP, onINP, onCLS, onFCP, onTTFB] as unknown as NonNullable<StartOptions['observers']>

/**
 * Starts reporting Core Web Vitals (FMS-75): LCP, INP, CLS, FCP and TTFB, as the browser settles them, queued and sent when the
 * page is hidden or closed (that is when LCP, INP and CLS are final), in requests of at most MAX_REPORTS_PER_REQUEST. Returns
 * a function that stops it.
 */
export function startWebVitals(options: StartOptions): () => void {
  const send = options.send ?? sendBody
  const doc = options.target ?? document
  const win = options.win ?? window
  const queue: WebVitalReport[] = []

  const flush = () => {
    while (queue.length > 0) send(bodyOf(queue.splice(0, MAX_REPORTS_PER_REQUEST)))
  }
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') flush()
  }

  for (const observe of options.observers ?? BROWSER_OBSERVERS) observe((metric) => queue.push(toReport(metric, options.page())))
  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('pagehide', flush)
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('pagehide', flush)
  }
}
