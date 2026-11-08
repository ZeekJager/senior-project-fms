import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Metric } from 'web-vitals'
import { currentUser, renderApp, signedInAs, signedOut } from '@/test/auth'
import { WebVitalsReporter } from './WebVitalsReporter'

const lcp = { name: 'LCP', value: 2100, rating: 'good' } as Metric

function setup(enabled = true) {
  let report: (m: Metric) => void = () => undefined
  const observer = vi.fn((r: (m: Metric) => void) => {
    report = r
  })
  const send = vi.fn(() => true)
  const target = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState }
  target.visibilityState = 'visible'
  const element = (
    <WebVitalsReporter
      enabled={enabled}
      send={send}
      observers={[observer]}
      target={target as unknown as Document}
      win={new EventTarget() as unknown as Window}
    />
  )
  const hide = () => {
    target.visibilityState = 'hidden'
    target.dispatchEvent(new Event('visibilitychange'))
  }
  return { element, observer, send, hide, report: (m: Metric) => report(m) }
}

describe('WebVitalsReporter', () => {
  it('reports a signed-in session’s metrics with the page template, when the page is hidden', async () => {
    signedInAs(currentUser(['driver'], ['trip:execute']))
    const t = setup()
    renderApp('/driver', { children: t.element })
    await screen.findByRole('button', { name: 'Notifications' })

    act(() => t.report(lcp))
    act(() => t.hide())

    expect(t.send).toHaveBeenCalledTimes(1)
    const body = JSON.parse((t.send.mock.calls[0] as unknown as [string])[0]) as { metrics: { name: string; page?: string }[] }
    expect(body.metrics).toEqual([{ name: 'LCP', value: 2100, rating: 'good', page: '/driver' }])
  })

  it('does not start for someone who is not signed in: the API takes reports from signed-in users only', async () => {
    signedOut()
    const t = setup()
    renderApp('/login', { children: t.element })
    await screen.findByRole('button', { name: /sign in/i })
    expect(t.observer).not.toHaveBeenCalled()
  })

  it('does not start when it is not enabled (development and tests do not report their own timings)', async () => {
    signedInAs(currentUser(['driver'], ['trip:execute']))
    const t = setup(false)
    renderApp('/driver', { children: t.element })
    await screen.findByRole('button', { name: 'Notifications' })
    expect(t.observer).not.toHaveBeenCalled()
  })
})
