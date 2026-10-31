import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { AttendanceCode } from './api'

const ADDIS = { id: 'd-1', name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }
const ADAMA = { id: 'd-2', name: 'Adama Hub', code: 'ADM', location: 'Adama' }

const base = currentUser(['dispatcher'], ['attendance:read', 'attendance:qr', 'driver:read', 'depot:read'])
const dispatcher = { ...base, user: { ...base.user, depot_id: ADDIS.id } }
const manager = currentUser(['fleet_manager'], ['attendance:read', 'attendance:write', 'attendance:qr', 'driver:read', 'depot:read'])
const driver = currentUser(['driver'], ['attendance:read', 'attendance:write', 'attendance:check-in', 'trip:execute'])

/** A code issued now on the server's clock, with the server's 30 s refresh and 60 s life unless changed. */
function code(n: number, overrides: Partial<AttendanceCode> = {}): AttendanceCode {
  const now = Date.now()
  return {
    depot_id: ADDIS.id,
    depot_name: ADDIS.name,
    work_starts_at: '08:00',
    late_after_minutes: 15,
    code: `FMSA1.${ADDIS.id}.${n}.signature${n}`,
    generated_at: new Date(now).toISOString(),
    issued_at: new Date(now).toISOString(),
    refresh_at: new Date(now + 30_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    ...overrides,
  }
}

/** Serves codes in turn, recording each request's depot. */
function serveCodes(next: (n: number) => AttendanceCode | 'error', depots = [ADDIS]) {
  const asked: (string | null)[] = []
  server.use(
    http.get('/api/v1/attendance/qr', ({ request }) => {
      asked.push(new URL(request.url).searchParams.get('depot_id'))
      const c = next(asked.length)
      return c === 'error' ? errorEnvelope(503, 'SERVICE_UNAVAILABLE', 'Down') : envelope(c)
    }),
    http.get('/api/v1/depots', () => envelope(depots)),
  )
  return asked
}

describe('S-24 Check-in code (FMS-141)', () => {
  it("shows the depot's QR with its start time and late line, and the next code when the server says", async () => {
    // The server says the next code is out in a second.
    const asked = serveCodes((n) => code(n, { refresh_at: new Date(Date.now() + 1_000).toISOString() }))
    signedInAs(dispatcher)
    renderApp('/attendance/qr')

    const qr = await screen.findByRole('img', { name: 'Check-in code for Addis Ababa Central' })
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/)
    expect(screen.getByText('Day starts 08:00 · late after 08:15')).toBeInTheDocument()
    expect(screen.getByText(/New code in \d+ s/)).toBeInTheDocument()
    const first = qr.querySelector('path')?.getAttribute('d')

    await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(2), { timeout: 4_000 })
    await waitFor(() => expect(screen.getByRole('img', { name: /Check-in code/ }).querySelector('path')?.getAttribute('d')).not.toBe(first))
    // Their own depot.
    expect(asked[0]).toBe(ADDIS.id)
  })

  it('never shows a code past its life: when the next cannot be fetched, it says it is reconnecting', async () => {
    // Already expired on the server's clock when it answered.
    serveCodes(() => code(1, { generated_at: new Date(Date.now() + 61_000).toISOString() }))
    signedInAs(dispatcher)
    renderApp('/attendance/qr')
    expect(await screen.findByRole('heading', { name: 'Reconnecting' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /Check-in code/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeDisabled()
  })

  it('says when the code cannot be loaded', async () => {
    serveCodes(() => 'error')
    signedInAs(dispatcher)
    renderApp('/attendance/qr')
    expect(await screen.findByRole('heading', { name: 'The code could not be loaded' })).toBeInTheDocument()
  })

  it('someone over several depots chooses one first; the code is then that depot’s', async () => {
    const asked = serveCodes((n) => code(n, { depot_id: ADAMA.id, depot_name: ADAMA.name }), [ADDIS, ADAMA])
    signedInAs(manager)
    renderApp('/attendance/qr')
    expect(await screen.findByRole('heading', { name: 'Choose a depot' })).toBeInTheDocument()
    expect(asked).toEqual([])

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Depot/ }))
    await user.click(await screen.findByRole('option', { name: 'Adama Hub' }))
    expect(await screen.findByRole('img', { name: 'Check-in code for Adama Hub' })).toBeInTheDocument()
    expect(asked).toEqual([ADAMA.id])
  })

  it('a driver cannot open it: nothing is fetched', async () => {
    const asked = serveCodes((n) => code(n))
    signedInAs(driver)
    renderApp('/attendance/qr')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.queryByRole('img', { name: /Check-in code/ })).not.toBeInTheDocument()
    expect(asked).toEqual([])
  })
})
