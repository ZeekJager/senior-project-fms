import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { today } from '@/features/documents/expiry'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { AttendanceRecord, RosterEntry } from './api'

const DEPOT = '11111111-1111-4111-8111-111111111111'
const depotAdmin = currentUser(['depot_admin'], ['attendance:read', 'attendance:write', 'driver:read', 'depot:read'])
const dispatcher = currentUser(['dispatcher'], ['attendance:read', 'driver:read', 'depot:read'])
const driverRole = currentUser(['driver'], ['attendance:read', 'attendance:write', 'trip:execute'])

let seq = 0
function entry(overrides: Partial<RosterEntry> = {}): RosterEntry {
  seq += 1
  return {
    driver_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    full_name: `Driver ${seq}`,
    email: `d${seq}@fleet.test`,
    depot_id: DEPOT,
    license_status: 'valid',
    date: today(),
    attendance: null,
    ...overrides,
  }
}

function record(status: AttendanceRecord['status'], id = `a-${++seq}`): AttendanceRecord {
  return { id, status, notes: null, logged_by: 'u-9', logged_by_name: 'Depot Clerk', created_at: '2026-10-10T05:12:00Z', updated_at: '2026-10-10T05:12:00Z' }
}

/** A fake roster over `entries` (mutated by the write handlers), with the status filters and counts. */
function serveRoster(entries: RosterEntry[]) {
  server.use(
    http.get('/api/v1/attendance', ({ request }) => {
      const q = new URL(request.url).searchParams
      const status = q.get('status')
      let rows = entries.filter((e) => !q.get('driver_id') || e.driver_id === q.get('driver_id'))
      if (status === 'unmarked') rows = rows.filter((e) => !e.attendance)
      else if (status) rows = rows.filter((e) => e.attendance?.status === status)
      const size = Number(q.get('page_size') ?? 100)
      return HttpResponse.json({ data: rows.slice(0, size), meta: { page: 1, page_size: size, total_items: rows.length, total_pages: 1, date: q.get('date') } })
    }),
    http.get('/api/v1/depots', () => envelope([{ id: DEPOT, name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }])),
  )
}

async function openAttendance(user = depotAdmin, path = '/attendance') {
  signedInAs(user)
  renderApp(path)
  await screen.findByRole('heading', { name: 'Attendance' })
}

const card = (name: string) => screen.getByRole('article', { name: new RegExp(`^${name}:`) })

describe('Attendance roll call (S-06)', () => {
  it("shows today's drivers as cards, and a click on an unmarked driver records them (POST)", async () => {
    const a = entry({ full_name: 'Abebe Kebede' })
    const entries = [a, entry({ full_name: 'Tigist Haile', attendance: record('absent') })]
    serveRoster(entries)
    let posted: unknown
    server.use(
      http.post('/api/v1/attendance', async ({ request }) => {
        posted = await request.json()
        a.attendance = record('present')
        return envelope(a.attendance)
      }),
    )
    const user = userEvent.setup()
    await openAttendance()
    await screen.findByRole('article', { name: /^Abebe Kebede:/ })

    expect(within(card('Tigist Haile')).getByRole('radio', { name: 'Absent' })).toHaveAttribute('aria-checked', 'true')
    expect(within(card('Abebe Kebede')).getByText('Not marked yet')).toBeInTheDocument()

    await user.click(within(card('Abebe Kebede')).getByRole('radio', { name: 'Present' }))
    await waitFor(() => expect(posted).toEqual({ driver_id: a.driver_id, date: today(), status: 'present' }))
    await waitFor(() => expect(within(card('Abebe Kebede')).getByRole('radio', { name: 'Present' })).toHaveAttribute('aria-checked', 'true'))
    expect(within(card('Abebe Kebede')).getByText(/Marked by Depot Clerk/)).toBeInTheDocument()
  })

  it('changing a marked driver updates their record (PUT)', async () => {
    const t = entry({ full_name: 'Tigist Haile', attendance: record('present', 'rec-1') })
    serveRoster([t])
    let put: { id: string; body: unknown } | undefined
    server.use(
      http.put('/api/v1/attendance/:id', async ({ params, request }) => {
        put = { id: String(params.id), body: await request.json() }
        t.attendance = { ...t.attendance!, status: 'on_leave' }
        return envelope(t.attendance)
      }),
    )
    const user = userEvent.setup()
    await openAttendance()
    await screen.findByRole('article', { name: /^Tigist Haile:/ })
    await user.click(within(card('Tigist Haile')).getByRole('radio', { name: 'On leave' }))
    await waitFor(() => expect(put).toEqual({ id: 'rec-1', body: { status: 'on_leave', notes: null } }))
  })

  it('if someone else recorded the driver first (409), applies the change to their record', async () => {
    const a = entry({ full_name: 'Abebe Kebede' })
    serveRoster([a])
    let put: string | undefined
    server.use(
      http.post('/api/v1/attendance', () => {
        a.attendance = record('present', 'theirs')
        return errorEnvelope(409, 'CONFLICT_ATTENDANCE_DUPLICATE')
      }),
      http.put('/api/v1/attendance/:id', ({ params }) => {
        put = String(params.id)
        a.attendance = { ...a.attendance!, status: 'absent' }
        return envelope(a.attendance)
      }),
    )
    const user = userEvent.setup()
    await openAttendance()
    await screen.findByRole('article', { name: /^Abebe Kebede:/ })
    await user.click(within(card('Abebe Kebede')).getByRole('radio', { name: 'Absent' }))
    await waitFor(() => expect(put).toBe('theirs'))
  })

  it('marks every unmarked driver present in one go', async () => {
    const entries = [entry(), entry(), entry({ attendance: record('absent') })]
    serveRoster(entries)
    const posted: string[] = []
    server.use(
      http.post('/api/v1/attendance', async ({ request }) => {
        const body = (await request.json()) as { driver_id: string }
        posted.push(body.driver_id)
        const target = entries.find((e) => e.driver_id === body.driver_id)!
        target.attendance = record('present')
        return envelope(target.attendance)
      }),
    )
    const user = userEvent.setup()
    await openAttendance()
    await user.click(await screen.findByRole('button', { name: 'Mark 2 unmarked present' }))
    await waitFor(() => expect(posted).toEqual([entries[0].driver_id, entries[1].driver_id]))
    expect(await screen.findByText('2 drivers marked present')).toBeInTheDocument()
  })

  it('a dispatcher reads the roll call but cannot change it', async () => {
    serveRoster([entry({ full_name: 'Abebe Kebede', attendance: record('absent') }), entry({ full_name: 'Hanna Tesfaye' })])
    await openAttendance(dispatcher)
    await screen.findByRole('article', { name: /^Abebe Kebede:/ })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(within(card('Abebe Kebede')).getByText('Absent')).toBeInTheDocument()
    expect(within(card('Hanna Tesfaye')).getByText('Not marked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /unmarked present/ })).not.toBeInTheDocument()
  })

  it('on a future day only leave can be chosen', async () => {
    const future = new Date(`${today()}T00:00:00Z`)
    future.setUTCDate(future.getUTCDate() + 3)
    const date = future.toISOString().slice(0, 10)
    serveRoster([entry({ full_name: 'Abebe Kebede', date })])
    await openAttendance(depotAdmin, `/attendance?date=${date}`)
    await screen.findByRole('article', { name: /^Abebe Kebede:/ })
    expect(within(card('Abebe Kebede')).getByRole('radio', { name: 'Present' })).toBeDisabled()
    expect(within(card('Abebe Kebede')).getByRole('radio', { name: 'On leave' })).toBeEnabled()
    expect(screen.getByText('Upcoming: leave only')).toBeInTheDocument()
  })

  it('filters by status from the stat cards, keeping it in the URL', async () => {
    serveRoster([entry({ full_name: 'Abebe Kebede', attendance: record('absent') }), entry({ full_name: 'Hanna Tesfaye' })])
    const user = userEvent.setup()
    await openAttendance()
    await screen.findByRole('article', { name: /^Hanna Tesfaye:/ })
    await user.click(screen.getByRole('button', { name: /^Absent/ }))
    await waitFor(() => expect(screen.queryByRole('article', { name: /^Hanna Tesfaye:/ })).not.toBeInTheDocument())
    expect(screen.getByTestId('location')).toHaveTextContent('/attendance?status=absent')
  })

  it('renders nothing for a driver', async () => {
    signedInAs(driverRole)
    renderApp('/attendance')
    await screen.findByText('Sam Tester')
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
  })

  it('says so when the depot has no drivers', async () => {
    serveRoster([])
    await openAttendance()
    expect(await screen.findByText('No drivers in this depot')).toBeInTheDocument()
  })
})
