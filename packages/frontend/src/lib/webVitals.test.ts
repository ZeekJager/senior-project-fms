import { describe, expect, it, vi } from 'vitest'
import type { Metric } from 'web-vitals'
import { MAX_REPORTS_PER_REQUEST, bodyOf, pageTemplate, startWebVitals, toReport, WEB_VITALS_URL, type StartOptions } from './webVitals'

const PATTERNS = ['/', '/vehicles', '/vehicles/:vehicleId/history', '/trips/:tripId']

describe('pageTemplate', () => {
  it('turns a path into the route template it matches, ids and all', () => {
    expect(pageTemplate('/vehicles', PATTERNS)).toBe('/vehicles')
    expect(pageTemplate('/vehicles/3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b/history', PATTERNS)).toBe('/vehicles/:vehicleId/history')
    expect(pageTemplate('/trips/abc', PATTERNS)).toBe('/trips/:tripId')
    expect(pageTemplate('/', PATTERNS)).toBe('/')
  })

  it('has none for a path no route has: the login page, a 404, a made-up URL never leaves the browser', () => {
    expect(pageTemplate('/login', PATTERNS)).toBeUndefined()
    expect(pageTemplate('/vehicles/1/2/3/4', PATTERNS)).toBeUndefined()
    expect(pageTemplate('/secret-thing/12345', PATTERNS)).toBeUndefined()
  })
})

describe('toReport', () => {
  it('keeps the metric, its rating and the page; rounds the value to 3 decimals', () => {
    expect(toReport({ name: 'LCP', value: 2345.6789, rating: 'good' }, '/vehicles')).toEqual({ name: 'LCP', value: 2345.679, rating: 'good', page: '/vehicles' })
    expect(toReport({ name: 'CLS', value: 0.0712345, rating: 'good' })).toEqual({ name: 'CLS', value: 0.071, rating: 'good' })
  })

  it('has no page key when there is none, so the API files it under "other"', () => {
    expect('page' in toReport({ name: 'TTFB', value: 800, rating: 'good' })).toBe(false)
  })
})

describe('startWebVitals', () => {
  const metric = (name: Metric['name'], value: number, rating: Metric['rating'] = 'good') => ({ name, value, rating }) as Metric

  function harness(page: () => string | undefined = () => '/vehicles') {
    let report: (m: Metric) => void = () => undefined
    const target = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState }
    target.visibilityState = 'visible'
    const win = new EventTarget()
    const send = vi.fn(() => true)
    const stop = startWebVitals({
      page,
      send,
      observers: [(r) => (report = r)],
      target: target as unknown as StartOptions['target'],
      win: win as unknown as StartOptions['win'],
    })
    const hide = () => {
      target.visibilityState = 'hidden'
      target.dispatchEvent(new Event('visibilitychange'))
    }
    return { report: (m: Metric) => report(m), send, hide, win, target, stop }
  }

  it('queues what the browser reports and sends nothing while the page is visible', () => {
    const h = harness()
    h.report(metric('LCP', 2100))
    h.report(metric('FCP', 900))
    expect(h.send).not.toHaveBeenCalled()
  })

  it('sends the queue when the page is hidden, as the API takes it', () => {
    const h = harness()
    h.report(metric('LCP', 2100))
    h.report(metric('INP', 180, 'good'))
    h.hide()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse((h.send.mock.calls[0] as unknown as [string])[0])).toEqual({
      metrics: [
        { name: 'LCP', value: 2100, rating: 'good', page: '/vehicles' },
        { name: 'INP', value: 180, rating: 'good', page: '/vehicles' },
      ],
    })
  })

  it('sends when the page is closed too, and never twice for the same report', () => {
    const h = harness()
    h.report(metric('CLS', 0.05))
    h.win.dispatchEvent(new Event('pagehide'))
    h.hide()
    h.win.dispatchEvent(new Event('pagehide'))
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('names the page a metric was reported on, not the one the user is on when it is sent', () => {
    let current: string | undefined = '/vehicles'
    const h = harness(() => current)
    h.report(metric('LCP', 1800))
    current = '/trips/:tripId'
    h.report(metric('INP', 250, 'needs-improvement'))
    h.hide()
    const body = JSON.parse((h.send.mock.calls[0] as unknown as [string])[0]) as { metrics: { name: string; page?: string }[] }
    expect(body.metrics.map((m) => [m.name, m.page])).toEqual([
      ['LCP', '/vehicles'],
      ['INP', '/trips/:tripId'],
    ])
  })

  it(`splits into requests of at most ${MAX_REPORTS_PER_REQUEST}, the API's limit`, () => {
    const h = harness()
    for (let i = 0; i < 25; i++) h.report(metric('FCP', 1000 + i))
    h.hide()
    expect(h.send.mock.calls.map((c) => (JSON.parse((c as unknown as [string])[0]) as { metrics: unknown[] }).metrics.length)).toEqual([10, 10, 5])
  })

  it('stops listening when stopped', () => {
    const h = harness()
    h.report(metric('LCP', 1))
    h.stop()
    h.hide()
    h.win.dispatchEvent(new Event('pagehide'))
    expect(h.send).not.toHaveBeenCalled()
  })

  it('sends nothing when there is nothing to send', () => {
    const h = harness()
    h.hide()
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('the request', () => {
  it('goes to the API’s web vitals route as a JSON body', () => {
    expect(WEB_VITALS_URL).toBe('/api/v1/telemetry/web-vitals')
    expect(JSON.parse(bodyOf([{ name: 'LCP', value: 1, rating: 'good' }]))).toEqual({ metrics: [{ name: 'LCP', value: 1, rating: 'good' }] })
  })
})
