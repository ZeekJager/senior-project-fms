import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { DriverFeedback } from '@/features/feedback/api'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'

// FMS-158: My feedback. The driver reads feedback, says "Got it", replies once, and disagrees by appealing.

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'appeal:submit'])
const ID = '7a1d1d1e-0000-4000-8000-00000000fb01'

function item(over: Partial<DriverFeedback> = {}): DriverFeedback {
  return {
    id: ID,
    subject: { type: 'month', trip_id: null, month: '2026-10', score_shown: 82 },
    category: 'safety',
    tone: 'needs_improvement',
    message: 'Three hard brakes near Bole this month. Keep more distance.',
    from: { id: 'm-1', name: 'Meron Manager' },
    given_at: '2026-11-20T07:30:00.000Z',
    edited_at: null,
    acknowledged_at: null,
    reply: null,
    replied_at: null,
    can: { edit: false, retract: false, acknowledge: true, reply: true, disagree: true },
    ...over,
  }
}

const page = (items: DriverFeedback[], unacknowledged = items.filter((i) => !i.acknowledged_at).length) =>
  HttpResponse.json({ data: items, meta: { request_id: 'r-1', page: 1, page_size: 100, total_items: items.length, total_pages: 1, unacknowledged } })

afterEach(() => localStorage.clear())

describe('My feedback (FMS-158)', () => {
  it('lists the feedback, opens one, acknowledges it and replies once', async () => {
    let current = item()
    const posted: { path: string; body: unknown }[] = []
    server.use(
      http.get('/api/v1/driver/feedback', () => page([current])),
      http.get(`/api/v1/driver/feedback/${ID}`, () => envelope(current)),
      http.post(`/api/v1/driver/feedback/${ID}/:action`, async ({ request, params }) => {
        const body = await request.json().catch(() => null)
        posted.push({ path: String(params.action), body })
        if (params.action === 'acknowledge') current = { ...current, acknowledged_at: '2026-11-21T08:00:00.000Z', can: { ...current.can, acknowledge: false } }
        if (params.action === 'reply') current = { ...current, reply: (body as { body: string }).body, replied_at: '2026-11-21T08:05:00.000Z', can: { ...current.can, reply: false } }
        return envelope(current)
      }),
    )
    signedInAs(driver)
    renderApp('/driver/feedback')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('link', { name: /Three hard brakes near Bole/ }))
    expect(await screen.findByText('From Meron Manager', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/October 2026 \(score 82\)/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Got it' }))
    expect(await screen.findByText(/You marked it as read/)).toBeInTheDocument()

    await user.type(screen.getByLabelText(/Reply \(once\)/), 'A truck cut in twice there.')
    await user.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(await screen.findByText('A truck cut in twice there.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send reply' })).not.toBeInTheDocument()
    expect(posted).toEqual([
      { path: 'acknowledge', body: {} },
      { path: 'reply', body: { body: 'A truck cut in twice there.' } },
    ])

    // "I disagree" opens an appeal of that month, naming the feedback.
    expect(screen.getByRole('link', { name: 'I disagree' })).toHaveAttribute('href', `/driver/appeals/new?feedback=${ID}&month=2026-10`)
  })

  it('with no signal, shows the feedback as last saved', async () => {
    server.use(http.get('/api/v1/driver/feedback', () => page([item()])))
    signedInAs(driver)
    const first = renderApp('/driver/feedback')
    expect(await screen.findByRole('link', { name: /Three hard brakes/ })).toBeInTheDocument()
    first.unmount()

    server.use(http.get('/api/v1/driver/feedback', () => HttpResponse.error()))
    signedInAs(driver)
    renderApp('/driver/feedback')
    expect(await screen.findByRole('link', { name: /Three hard brakes/ })).toBeInTheDocument()
    expect(await screen.findByText(/No signal: this is your feedback as last saved/)).toBeInTheDocument()
  })

  it('a retracted item is gone: opening it says so', async () => {
    server.use(http.get(`/api/v1/driver/feedback/${ID}`, () => errorEnvelope(404, 'NOT_FOUND')))
    signedInAs(driver)
    renderApp(`/driver/feedback/${ID}`)
    expect(await screen.findByText('This feedback could not be loaded')).toBeInTheDocument()
  })

  it('My day links to My feedback with how much is new', async () => {
    server.use(http.get('/api/v1/driver/feedback', () => page([item(), item({ id: `${ID.slice(0, -1)}2` })])))
    signedInAs(driver)
    renderApp('/driver')
    expect(await screen.findByText('2 new from your managers')).toBeInTheDocument()
  })
})
