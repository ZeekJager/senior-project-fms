import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Feedback } from '@/features/feedback/api'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'

// FMS-158: a driver's feedback for their managers, opened from the Drivers screen or from a completed trip.

const DRIVER = '00000000-0000-4000-8000-0000000000d1'
const TRIP = '00000000-0000-4000-8000-0000000000a1'
const manager = currentUser(['fleet_manager'], ['driver:read', 'depot:read', 'feedback:read', 'feedback:write'])

function given(over: Partial<Feedback> = {}): Feedback {
  return {
    id: '00000000-0000-4000-8000-0000000000f1',
    subject: { type: 'trip', trip_id: TRIP, month: null, score_shown: null },
    category: 'safety',
    tone: 'needs_improvement',
    message: 'Three hard brakes near Bole. Keep more distance.',
    from: { id: 'u-1', name: 'Sam Tester' },
    given_at: '2026-11-10T07:30:00.000Z',
    edited_at: null,
    acknowledged_at: '2026-11-11T08:00:00.000Z',
    reply: 'A truck cut in twice there.',
    replied_at: '2026-11-11T08:05:00.000Z',
    can: { edit: true, retract: true, acknowledge: false, reply: false, disagree: false },
    driver: { id: DRIVER, name: 'Abebe Kebede' },
    depot: { id: 'dep-1', name: 'Addis North' },
    editable_until: '2026-11-11T07:30:00.000Z',
    retracted_at: null,
    retracted_by: null,
    retraction_reason: null,
    unacknowledged_overdue: false,
    revisions: [],
    version: 1,
    ...over,
  }
}

function serve(items: Feedback[]) {
  const posted: { method: string; path: string; body: unknown }[] = []
  let list = items
  server.use(
    http.get('/api/v1/drivers', () => HttpResponse.json({ data: [], meta: { request_id: 'r', page: 1, page_size: 25, total_items: 0, total_pages: 0 } })),
    http.get('/api/v1/depots', () => envelope([])),
    http.get(`/api/v1/drivers/${DRIVER}`, () => envelope({ id: DRIVER, full_name: 'Abebe Kebede' })),
    http.get(`/api/v1/drivers/${DRIVER}/feedback`, () =>
      HttpResponse.json({
        data: list,
        meta: { request_id: 'r', page: 1, page_size: 25, total_items: list.length, total_pages: 1, counts: { days: 90, by_category: { safety: list.length }, unacknowledged_overdue: list.filter((f) => f.unacknowledged_overdue).length } },
      }),
    ),
    http.get('/api/v1/settings/definitions/feedback_categories', () => envelope({ key: 'feedback_categories', value: ['safety', 'punctuality'] })),
    http.get('/api/v1/feedback/templates', () => envelope([{ id: 't-1', category: 'safety', title: 'Distance', body: 'Keep three seconds behind the vehicle ahead.', updated_at: '2026-11-01T00:00:00Z', version: 1 }])),
    http.get('/api/v1/trips', () => envelope([])),
    http.post(`/api/v1/drivers/${DRIVER}/feedback`, async ({ request }) => {
      const body = await request.json()
      posted.push({ method: 'POST', path: 'give', body })
      const made = given({ id: '00000000-0000-4000-8000-0000000000f2', message: (body as { message: string }).message, acknowledged_at: null, reply: null, replied_at: null })
      list = [made, ...list]
      return HttpResponse.json({ data: made, meta: { request_id: 'r' } }, { status: 201 })
    }),
    http.patch('/api/v1/feedback/:id', async ({ request, params }) => {
      const body = await request.json()
      posted.push({ method: 'PATCH', path: String(params.id), body })
      list = list.map((f) => (f.id === params.id ? { ...f, message: (body as { message: string }).message, edited_at: '2026-11-10T09:00:00.000Z', revisions: [{ message: f.message, revised_by: f.from, at: '2026-11-10T09:00:00.000Z' }] } : f))
      return envelope(list.find((f) => f.id === params.id))
    }),
  )
  return posted
}

describe('Driver feedback for managers (FMS-158)', () => {
  it('opens from a trip with the trip chosen, and gives feedback with a template', async () => {
    const posted = serve([given({ unacknowledged_overdue: false })])
    signedInAs(manager)
    renderApp(`/drivers?feedback=${DRIVER}&give=trip&trip=${TRIP}`)
    const user = userEvent.setup()

    const form = await screen.findByRole('form', { name: 'Give feedback' })
    expect(await screen.findByRole('heading', { name: 'Feedback: Abebe Kebede' })).toBeInTheDocument()
    expect(within(form).getByLabelText('About')).toHaveValue('trip')
    expect(within(form).getByLabelText('Trip')).toHaveValue(TRIP)
    // Only the categories in use are offered.
    expect(within(within(form).getByLabelText('Category')).queryByRole('option', { name: 'Vehicle care' })).not.toBeInTheDocument()

    await user.selectOptions(within(form).getByLabelText('Category'), 'safety')
    await user.selectOptions(within(form).getByLabelText('Tone'), 'needs_improvement')
    await user.selectOptions(within(form).getByLabelText('Start from a template'), 't-1')
    expect(within(form).getByLabelText(/^Message/)).toHaveValue('Keep three seconds behind the vehicle ahead.')
    await user.click(within(form).getByRole('button', { name: 'Send feedback' }))

    expect(await screen.findByText('Feedback sent')).toBeInTheDocument()
    expect(posted).toEqual([{ method: 'POST', path: 'give', body: { subject_type: 'trip', trip_id: TRIP, category: 'safety', tone: 'needs_improvement', message: 'Keep three seconds behind the vehicle ahead.' } }])
  })

  it('shows the driver’s reading and reply, flags a week unread, and corrects within 24 hours', async () => {
    const stale = given({ id: '00000000-0000-4000-8000-0000000000f3', acknowledged_at: null, reply: null, replied_at: null, unacknowledged_overdue: true, can: { edit: false, retract: true, acknowledge: false, reply: false, disagree: false } })
    const posted = serve([given(), stale])
    signedInAs(manager)
    renderApp(`/drivers?feedback=${DRIVER}`)
    const user = userEvent.setup()

    const list = await screen.findByRole('list', { name: 'Feedback to Abebe Kebede' })
    expect(within(list).getByText(/Read by the driver/)).toBeInTheDocument()
    expect(within(list).getByText('A truck cut in twice there.')).toBeInTheDocument()
    expect(within(list).getByText('Not read after 7 days')).toBeInTheDocument()
    expect(screen.getByText('1 item not read after 7 days')).toBeInTheDocument()

    const first = within(list).getAllByRole('listitem')[0]
    await user.click(within(first).getByRole('button', { name: 'Correct' }))
    const box = within(first).getByLabelText(/^Message/)
    await user.clear(box)
    await user.type(box, 'Two hard brakes near Bole. Keep more distance.')
    await user.click(within(first).getByRole('button', { name: 'Save correction' }))
    expect(await screen.findByText('Feedback corrected')).toBeInTheDocument()
    expect(posted).toEqual([{ method: 'PATCH', path: given().id, body: { message: 'Two hard brakes near Bole. Keep more distance.' } }])
    expect(await within(list).findByText('Earlier text')).toBeInTheDocument()
  })
})
