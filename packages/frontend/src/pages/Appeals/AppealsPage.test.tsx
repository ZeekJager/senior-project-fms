import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import { appealDetail } from '@/features/appeals/fixtures'
import type { AppealDetail } from '@/features/appeals/api'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'

// FMS-159: S-36, the reviewers' queue of score appeals and the drawer where they are claimed and decided.

const manager = currentUser(['fleet_manager'], ['appeal:read', 'appeal:review'])
const officer = currentUser(['compliance_officer'], ['appeal:read'])

const evidence: AppealDetail['evidence'] = {
  track: null,
  flag: { type: 'speeding', observed_at: '2026-11-20T07:30:00.000Z', resolved_at: '2026-11-20T07:33:00.000Z' },
  incident: null,
  trip_flags: [{ id: '7a1d1d1e-0000-4000-8000-0000000000f1', type: 'speeding', observed_at: '2026-11-20T07:30:00.000Z', resolved_at: null, excluded: false }],
  score: {
    month: '2026-11',
    score: 97,
    reason: null,
    components: { punctuality: { score: 100, weight: 35 }, safety: { score: 90, weight: 35 }, incidents: { score: 100, weight: 20 }, dvir: { score: 100, weight: 10 } },
    figures: { trips_completed: 4, distance_m: 400000, speeding: 2, idling: 0, accidents: 0 },
  },
  corrections: ['exclude_flag', 'exclude_trip'],
}

function serve(first: AppealDetail) {
  let current = first
  const posted: { path: string; body: unknown }[] = []
  server.use(
    http.get('/api/v1/appeals', () => envelope([current], 200, { page: 1, page_size: 25, total_items: 1, total_pages: 1 })),
    http.get(`/api/v1/appeals/${first.id}`, () => envelope(current)),
    http.post(`/api/v1/appeals/${first.id}/:step`, async ({ request, params }) => {
      const body = await request.json().catch(() => null)
      posted.push({ path: String(params.step), body })
      if (params.step === 'claim') current = { ...current, status: 'under_review', claimed_by: { id: 'm', name: 'Meron Manager' }, can: { ...current.can, claim: false, decide: true } }
      if (params.step === 'decision') current = { ...current, status: 'rejected', outcome: 'rejected', decision_note: (body as { note: string }).note, can: { ...current.can, decide: false, comment: false } }
      return envelope(current)
    }),
  )
  return posted
}

describe('Score appeals (S-36, FMS-159)', () => {
  it('lists the open appeals, opens one with its evidence, claims it and decides it with a note', async () => {
    const posted = serve(appealDetail({ evidence, can: { claim: true, comment: true, decide: false, withdraw: false, acknowledge: false } }))
    signedInAs(manager)
    renderApp('/appeals')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: "Open Abebe Kebede's appeal" }))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByRole('region', { name: 'Flags on the trip' })).toHaveTextContent('Appealed')
    expect(within(drawer).getByRole('region', { name: 'Score, November 2026' })).toHaveTextContent('97')

    await user.click(within(drawer).getByRole('button', { name: 'Claim for review' }))
    expect(posted.map((p) => p.path)).toEqual(['claim'])

    await user.click(await within(drawer).findByRole('radio', { name: 'Reject' }))
    await user.click(within(drawer).getByRole('button', { name: 'Reject' }))
    expect(within(drawer).getByRole('alert')).toHaveTextContent('Write a decision note: the driver reads it.')
    await user.type(within(drawer).getByLabelText('Decision note'), 'Two pings confirm the speed.')
    await user.click(within(drawer).getByRole('button', { name: 'Reject' }))
    expect(posted[1]).toEqual({ path: 'decision', body: { outcome: 'rejected', note: 'Two pings confirm the speed.' } })
  })

  it('an approval names what it takes out of the score', async () => {
    const posted = serve(appealDetail({ status: 'under_review', evidence, can: { claim: false, comment: true, decide: true, withdraw: false, acknowledge: false } }))
    signedInAs(manager)
    renderApp('/appeals?appeal=7a1d1d1e-0000-4000-8000-000000000001')
    const user = userEvent.setup()
    const drawer = await screen.findByRole('dialog')
    await user.click(await within(drawer).findByRole('radio', { name: 'Approve' }))
    await user.type(within(drawer).getByLabelText('Decision note'), 'The GPS jumped.')
    await user.click(within(drawer).getByRole('button', { name: 'Approve' }))
    expect(within(drawer).getByRole('alert')).toHaveTextContent('Choose what the approval takes out of the score.')
    await user.selectOptions(within(drawer).getByLabelText('What it takes out of the score'), 'exclude_flag')
    await user.click(within(drawer).getByRole('button', { name: 'Approve' }))
    expect(posted).toEqual([{ path: 'decision', body: { outcome: 'approved', note: 'The GPS jumped.', correction: 'exclude_flag' } }])
  })

  it('a compliance officer reads appeals but cannot claim or decide them', async () => {
    serve(appealDetail({ evidence, can: { claim: false, comment: false, decide: false, withdraw: false, acknowledge: false } }))
    signedInAs(officer)
    renderApp('/appeals?appeal=7a1d1d1e-0000-4000-8000-000000000001')
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByRole('region', { name: 'Timeline' })).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Claim for review' })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('region', { name: 'Decision' })).not.toBeInTheDocument()
  })
})
