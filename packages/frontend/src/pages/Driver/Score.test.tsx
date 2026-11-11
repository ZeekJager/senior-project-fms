import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentMonth, monthLabel, shiftMonth } from '@/lib/month'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { MyPerformance } from './api'

// FMS-146: the driver's own score, from GET /analytics/my-performance.

const driver = currentUser(['driver'], ['trip:execute', 'trip:read'])
const dispatcher = currentUser(['dispatcher'], ['trip:execute', 'trip:read', 'trip:assign'])

const LAST = shiftMonth(currentMonth(), -1)

const performance = (overrides: Partial<MyPerformance> = {}): MyPerformance => ({
  month: LAST,
  score: 63,
  reason: null,
  min_trips: 3,
  trips_completed: 4,
  distance_m: 400_000,
  components: {
    punctuality: { score: 50, weight: 35, trips_timed: 4, trips_on_time: 2 },
    safety: { score: 80, weight: 35, speeding: 4, idling: 0 },
    incidents: { score: 50, weight: 20, accidents: 1 },
    dvir: { score: 75, weight: 10, trips_inspected: 3 },
  },
  ...overrides,
})

/** GET /analytics/my-performance, with the months asked for. */
function serve(answer: (month: string) => MyPerformance) {
  const months: string[] = []
  server.use(
    http.get('/api/v1/analytics/my-performance', ({ request }) => {
      const month = new URL(request.url).searchParams.get('month') ?? ''
      months.push(month)
      return envelope(answer(month))
    }),
  )
  return months
}

describe('My score (FMS-146)', () => {
  it("shows the driver's score for last month and each part, with what it was worked out from", async () => {
    const months = serve(() => performance())
    signedInAs(driver)
    renderApp('/driver/score')

    const score = await screen.findByRole('region', { name: `Your score for ${monthLabel(LAST)}` })
    expect(within(score).getByText('63')).toBeInTheDocument()
    expect(within(score).getByText('4 trips · 400 km')).toBeInTheDocument()
    expect(months).toEqual([LAST])

    const parts = screen.getByRole('region', { name: 'What makes it up' })
    expect(within(parts).getByText('2 of 4 trips ended within 15 minutes of the schedule.')).toBeInTheDocument()
    expect(within(parts).getByText('4 speeding alerts and 0 idling alerts over 400 km.')).toBeInTheDocument()
    expect(within(parts).getByText('1 accident over 400 km.')).toBeInTheDocument()
    expect(within(parts).getByText('3 of 4 trips inspected before setting off.')).toBeInTheDocument()
    expect(within(parts).getAllByText('Counts for 35% of the score.')).toHaveLength(2)
    expect(within(parts).getByRole('meter', { name: 'Safe driving, 80 out of 100' })).toHaveAttribute('aria-valuenow', '80')
    // Never a rank, never anyone else.
    expect(screen.queryByText(/rank/i)).not.toBeInTheDocument()
  })

  it('is opened from My day, not a tab of its own', async () => {
    serve(() => performance())
    server.use(http.get('/api/v1/trips', () => envelope([])))
    signedInAs(driver)
    renderApp('/driver')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('link', { name: /My score/ }))
    expect(await screen.findByRole('heading', { name: 'My score', level: 1 })).toBeInTheDocument()
    expect(within(screen.queryByRole('navigation', { name: 'Main' }) ?? document.createElement('nav')).queryByText('My score')).not.toBeInTheDocument()
  })

  it('steps to another month', async () => {
    const months = serve((month) => performance({ month, score: month === LAST ? 63 : 88 }))
    signedInAs(driver)
    renderApp('/driver/score')
    const user = userEvent.setup()
    await screen.findByText('63')

    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(await screen.findByText('88')).toBeInTheDocument()
    expect(months).toEqual([LAST, shiftMonth(LAST, -1)])
  })

  it('with too few trips, says how many a score needs, not a low score; a part not judged says why', async () => {
    serve(() =>
      performance({
        score: null,
        reason: 'not_enough_trips',
        trips_completed: 2,
        distance_m: 5_000,
        components: { ...performance().components, safety: { score: null, weight: 35, speeding: 0, idling: 0 } },
      }),
    )
    signedInAs(driver)
    renderApp('/driver/score')

    expect(await screen.findByText(`No score for ${monthLabel(LAST)}`)).toBeInTheDocument()
    expect(screen.getByText('A score needs 3 completed trips in the month. You completed 2.')).toBeInTheDocument()
    expect(screen.getAllByText('Judged from 10 km driven.').length).toBeGreaterThan(0)
  })

  it('tells a staff member that only drivers have a score', async () => {
    server.use(http.get('/api/v1/analytics/my-performance', () => errorEnvelope(404, 'RESOURCE_NOT_FOUND', 'Only a driver has a performance record.')))
    signedInAs(dispatcher)
    renderApp('/driver/score')

    expect(await screen.findByText('Only drivers have a score')).toBeInTheDocument()
  })
})
