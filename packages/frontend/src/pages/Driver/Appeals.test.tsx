import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import { appealDetail } from '@/features/appeals/fixtures'
import { createApiClient } from '@/lib/api/client'
import { currentMonth, monthLabel, shiftMonth } from '@/lib/month'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'

// FMS-159: a driver appeals a flag with a photo, follows it, and reads the decision.

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'appeal:submit'])
const LAST = shiftMonth(currentMonth(), -1)
const FLAG = '7a1d1d1e-0000-4000-8000-0000000000f1'

describe('Appealing (FMS-159)', () => {
  it('sends an appeal of a flag with a photo, and opens it', async () => {
    const created = appealDetail()
    server.use(
      http.get('/api/v1/appeals/appealable', () =>
        envelope({ items: [{ target_type: 'flag', id: FLAG, kind: 'speeding', at: '2026-11-20T07:30:00.000Z', trip_id: null, open_appeal_id: null, excluded: false }], months: [LAST], window_days: 30 }),
      ),
      http.get(`/api/v1/appeals/${created.id}`, () => envelope(created)),
    )
    // jsdom's File cannot be streamed by Node's fetch, so the multipart body is captured where the app hands it to fetch.
    let sent: FormData | null = null
    const api = createApiClient((input, init) => {
      const url = new URL(String(input), window.location.origin)
      if (url.pathname === '/api/v1/appeals' && init?.method === 'POST') {
        sent = init.body as FormData
        return Promise.resolve(Response.json({ data: created, meta: {} }, { status: 201 }))
      }
      return fetch(url, init)
    })
    signedInAs(driver)
    renderApp('/driver/appeals/new', { api })
    const user = userEvent.setup()

    await user.selectOptions(await screen.findByLabelText('What is it about?'), `flag:${FLAG}`)
    await user.selectOptions(screen.getByLabelText('Why?'), 'wrong_data')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Say what happened in at least 20 characters.')).toBeInTheDocument()
    expect(sent).toBeNull()

    await user.type(screen.getByLabelText('What happened'), 'The GPS jumped near the bridge; I was going 60.')
    await user.upload(screen.getByLabelText('Add photos or files'), new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'speedo.jpg', { type: 'image/jpeg' }))
    expect(screen.getByRole('list', { name: 'Attached' })).toHaveTextContent('speedo.jpg')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('heading', { name: /Flag on/ })).toBeInTheDocument()
    const form = sent as unknown as FormData
    expect(form.get('target_type')).toBe('flag')
    expect(form.get('target_id')).toBe(FLAG)
    expect(form.get('reason')).toBe('wrong_data')
    expect(form.getAll('files')).toHaveLength(1)
  })

  it('refuses a file that is not a photo or PDF before sending', async () => {
    server.use(http.get('/api/v1/appeals/appealable', () => envelope({ items: [], months: [LAST], window_days: 30 })))
    signedInAs(driver)
    renderApp('/driver/appeals/new')
    const user = userEvent.setup({ applyAccept: false })
    await user.upload(await screen.findByLabelText('Add photos or files'), new File(['x'], 'notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
    expect(screen.getByText('notes.docx: photos (JPEG, PNG, WebP) or PDF only.')).toBeInTheDocument()
  })

  it('says so when the flag already has an open appeal', async () => {
    server.use(
      http.get('/api/v1/appeals/appealable', () => envelope({ items: [], months: [LAST], window_days: 30 })),
      http.post('/api/v1/appeals', () => errorEnvelope(409, 'CONFLICT_APPEAL_OPEN', 'There is already an open appeal against this.')),
    )
    signedInAs(driver)
    renderApp(`/driver/appeals/new?month=${LAST}`)
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByLabelText('Why?'), 'road_conditions')
    await user.type(screen.getByLabelText('What happened'), 'Roadworks all month made every trip slow.')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('You already have an open appeal against this. Follow it in My appeals.')).toBeInTheDocument()
  })

  it('shows the decision with the corrected score, and the driver acknowledges it', async () => {
    const approved = appealDetail({
      status: 'approved',
      outcome: 'approved',
      decided_by: { id: 'r1', name: 'Hana Reviewer' },
      decided_at: '2026-11-21T10:00:00.000Z',
      decision_note: 'The GPS jumped there; the flag is wrong.',
      correction: 'exclude_flag',
      score_before: 72,
      score_after: 80,
      can: { claim: false, comment: false, decide: false, withdraw: false, acknowledge: true },
    })
    let acknowledged = false
    server.use(
      http.get(`/api/v1/appeals/${approved.id}`, () => envelope(acknowledged ? { ...approved, status: 'closed', can: { ...approved.can, acknowledge: false } } : approved)),
      http.post(`/api/v1/appeals/${approved.id}/acknowledge`, () => {
        acknowledged = true
        return envelope({ ...approved, status: 'closed', acknowledged_at: '2026-11-21T11:00:00.000Z', can: { ...approved.can, acknowledge: false } })
      }),
    )
    signedInAs(driver)
    renderApp(`/driver/appeals/${approved.id}`)
    const decision = await screen.findByRole('region', { name: 'The decision' })
    expect(within(decision).getByText('The GPS jumped there; the flag is wrong.')).toBeInTheDocument()
    expect(decision).toHaveTextContent('Your score: 72 to 80.')
    await userEvent.setup().click(within(decision).getByRole('button', { name: 'I have read the decision' }))
    expect(acknowledged).toBe(true)
    expect(screen.queryByRole('button', { name: 'I have read the decision' })).not.toBeInTheDocument()
  })

  it('My score says when the month was corrected after an appeal, and offers to appeal it', async () => {
    server.use(
      http.get('/api/v1/analytics/my-performance', () =>
        envelope({
          month: LAST,
          score: 80,
          reason: null,
          min_trips: 3,
          trips_completed: 4,
          distance_m: 400_000,
          components: {
            punctuality: { score: 100, weight: 35, trips_timed: 4, trips_on_time: 4 },
            safety: { score: 90, weight: 35, speeding: 2, idling: 0 },
            incidents: { score: 100, weight: 20, accidents: 0 },
            dvir: { score: 100, weight: 10, trips_inspected: 4 },
          },
          corrections: [{ appeal_id: 'a1', correction: 'exclude_flag', score_before: 72, score_after: 80, decided_at: '2026-11-21T10:00:00.000Z' }],
        }),
      ),
    )
    signedInAs(driver)
    renderApp('/driver/score')
    const score = await screen.findByRole('region', { name: `Your score for ${monthLabel(LAST)}` })
    expect(within(score).getByText('Corrected after appeal: 72 to 80')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Appeal this score/ })).toHaveAttribute('href', `/driver/appeals/new?month=${LAST}`)
  })
})
