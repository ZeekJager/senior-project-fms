import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useRef, useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import { enqueue, MAX_PENDING, submissionsOf } from '@/lib/offlineQueue'
import { createQueryClient } from '@/lib/query'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs, testApi } from '@/test/auth'
import { server } from '@/test/msw/server'
import { OfflineQueueProvider, useOfflineQueue, type SubmitResult } from './OfflineQueue'
import { PendingSubmissions } from './PendingSubmissions'

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read', 'dvir:write'])
const ME = driver.user.id

const report = (n: number) => ({ kind: 'dvir', label: `Pre-trip inspection ${n}`, path: '/dvir-reports', body: { n } })

/** A form stand-in, as S-12 will use the queue: submit, then say what happened. */
function Form() {
  const { submit } = useOfflineQueue()
  const { status } = useAuth()
  const [said, setSaid] = useState('')
  const made = useRef(0)
  async function send() {
    try {
      const result: SubmitResult = await submit(report(++made.current))
      setSaid(result.status === 'rejected' ? `rejected: ${result.rejection.message}` : result.status)
    } catch (err) {
      setSaid((err as Error).message)
    }
  }
  if (status !== 'authenticated') return null
  return (
    <>
      <button type="button" onClick={() => void send()}>
        Submit
      </button>
      <p data-testid="said">{said}</p>
    </>
  )
}

function renderQueue() {
  signedInAs(driver)
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <AuthProvider api={testApi()}>
          <OfflineQueueProvider>
            <PendingSubmissions />
            <Form />
          </OfflineQueueProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/**
 * POST /dvir-reports as the idempotency middleware answers it (FMS-87):
 * a key seen before is answered from the record and adds nothing.
 */
function serveReports(state: { up: boolean; dropAnswerOnce?: boolean }) {
  const records: unknown[] = []
  const keys: string[] = []
  const stored = new Map<string, unknown>()
  server.use(
    http.post('/api/v1/dvir-reports', async ({ request }) => {
      if (!state.up) return HttpResponse.error()
      const key = request.headers.get('Idempotency-Key')!
      keys.push(key)
      const body = await request.json()
      if (!stored.has(key)) {
        records.push(body)
        stored.set(key, { id: `dvir-${records.length}`, ...(body as object) })
      }
      if (state.dropAnswerOnce) {
        state.dropAnswerOnce = false
        return HttpResponse.error()
      }
      return HttpResponse.json({ data: stored.get(key), meta: { created: true, request_id: 'r' } }, { status: 201 })
    }),
  )
  return { records, keys }
}

const said = () => screen.getByTestId('said')
const submitOne = async (user: ReturnType<typeof userEvent.setup>, expected: string) => {
  await user.click(await screen.findByRole('button', { name: 'Submit' }))
  await waitFor(() => expect(said()).toHaveTextContent(expected))
}

afterEach(() => {
  // An 'offline' event also pauses TanStack Query's global online manager: put it back.
  act(() => void window.dispatchEvent(new Event('online')))
})

describe('offline queue in the driver app (FMS-81)', () => {
  it('online: a submission goes at once with an Idempotency-Key, and nothing is left waiting', async () => {
    const { records, keys } = serveReports({ up: true })
    renderQueue()
    const user = userEvent.setup()
    await submitOne(user, 'sent')
    expect(records).toEqual([{ n: 1 }])
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(await submissionsOf(ME)).toEqual([])
    expect(screen.queryByRole('button', { name: /waiting to send/ })).not.toBeInTheDocument()
  })

  it('offline: submissions wait on the phone with a pending badge, and go in order once the signal is back', async () => {
    const state = { up: false }
    const { records } = serveReports(state)
    renderQueue()
    const user = userEvent.setup()
    act(() => void window.dispatchEvent(new Event('offline')))
    await submitOne(user, 'queued')
    await user.click(screen.getByRole('button', { name: 'Submit' }))
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    const badge = await screen.findByRole('button', { name: '3 waiting to send' })
    expect(badge).toHaveTextContent('3')
    expect(records).toEqual([])

    state.up = true
    const back = Date.now()
    act(() => void window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]))
    expect(Date.now() - back).toBeLessThan(10_000)
    await waitFor(() => expect(screen.queryByRole('button', { name: /waiting to send/ })).not.toBeInTheDocument())
    expect(await submissionsOf(ME)).toEqual([])
  })

  it('a submission the server got, whose answer was lost, is sent again with the same key and recorded once', async () => {
    const state = { up: true, dropAnswerOnce: true }
    const { records, keys } = serveReports(state)
    renderQueue()
    await submitOne(userEvent.setup(), 'queued')
    act(() => void window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(keys).toHaveLength(2))
    expect(keys[0]).toBe(keys[1])
    expect(records).toHaveLength(1)
    await waitFor(async () => expect(await submissionsOf(ME)).toEqual([]))
  })

  it(`the ${MAX_PENDING + 1}st is refused with a clear message, and nothing more is kept`, async () => {
    for (let n = 1; n <= MAX_PENDING; n++) await enqueue({ ownerId: ME, ...report(n) })
    serveReports({ up: false })
    renderQueue()
    expect(await screen.findByRole('button', { name: `${MAX_PENDING} waiting to send` })).toBeInTheDocument()
    await submitOne(userEvent.setup(), '50 submissions are already waiting to send. Get signal to send them before adding another.')
    expect(await submissionsOf(ME)).toHaveLength(MAX_PENDING)
  })

  it('refused when sent at once: the form hears why and nothing is kept', async () => {
    server.use(http.post('/api/v1/dvir-reports', () => errorEnvelope(422, 'VALIDATION_FAILED', 'Each item once.')))
    renderQueue()
    await submitOne(userEvent.setup(), 'rejected: Each item once.')
    expect(await submissionsOf(ME)).toEqual([])
  })

  it('refused later: listed as not sent with the reason, until the driver removes it; the rest still go', async () => {
    await enqueue({ ownerId: ME, ...report(1) })
    await enqueue({ ownerId: ME, ...report(2) })
    const records: unknown[] = []
    server.use(
      http.post('/api/v1/dvir-reports', async ({ request }) => {
        const body = (await request.json()) as { n: number }
        if (body.n === 1) return errorEnvelope(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'You can only inspect the vehicle on your trip.')
        records.push(body)
        return HttpResponse.json({ data: body, meta: {} }, { status: 201 })
      }),
    )
    renderQueue()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '1 not sent' }))
    expect(records).toEqual([{ n: 2 }])

    const list = screen.getByRole('dialog', { name: 'Waiting to send' })
    const entry = within(list).getByRole('listitem')
    expect(entry).toHaveTextContent('Pre-trip inspection 1')
    expect(entry).toHaveTextContent('Not sent')
    expect(entry).toHaveTextContent('The server turned it down: You can only inspect the vehicle on your trip.')
    await user.click(within(entry).getByRole('button', { name: 'Remove Pre-trip inspection 1' }))
    await waitFor(() => expect(within(list).getByText('Everything has been sent.')).toBeInTheDocument())
    expect(await submissionsOf(ME)).toEqual([])
  })

  it('the list shows what is waiting, oldest first; sending needs signal', async () => {
    await enqueue({ ownerId: ME, ...report(1) }, Date.parse('2026-11-02T05:12:00Z'))
    await enqueue({ ownerId: ME, ...report(2) }, Date.parse('2026-11-02T05:40:00Z'))
    serveReports({ up: false })
    renderQueue()
    const user = userEvent.setup()
    act(() => void window.dispatchEvent(new Event('offline')))
    await user.click(await screen.findByRole('button', { name: '2 waiting to send' }))
    const list = screen.getByRole('dialog', { name: 'Waiting to send' })
    expect(within(list).getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent)).toEqual(['Pre-trip inspection 1', 'Pre-trip inspection 2'])
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Made 2 Nov, 08:12')
    expect(within(list).getByRole('button', { name: 'Needs signal' })).toBeDisabled()
  })

  it('a session that cannot be renewed pauses the queue with everything kept; signing in again sends it', async () => {
    await enqueue({ ownerId: ME, ...report(1) })
    await enqueue({ ownerId: ME, ...report(2) })
    let refreshes = 0
    server.use(
      // The load's refresh works; the one after the submission's 401 is refused.
      http.post('/api/v1/auth/refresh', () => (++refreshes === 1 ? envelope(driver) : errorEnvelope(401, 'AUTH_TOKEN_INVALID'))),
      http.post('/api/v1/dvir-reports', () => errorEnvelope(401, 'AUTH_TOKEN_EXPIRED')),
    )
    const first = render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <AuthProvider api={testApi()}>
            <OfflineQueueProvider>
              <PendingSubmissions />
            </OfflineQueueProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(refreshes).toBe(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: /waiting to send/ })).not.toBeInTheDocument())
    expect((await submissionsOf(ME)).map((s) => s.state)).toEqual(['pending', 'pending'])
    first.unmount()

    const { records } = serveReports({ up: true })
    renderQueue()
    await waitFor(() => expect(records).toEqual([{ n: 1 }, { n: 2 }]))
  })

  it("another driver's submissions on this phone are never shown or sent", async () => {
    await enqueue({ ownerId: 'someone-else', ...report(1) })
    const { records } = serveReports({ up: true })
    renderQueue()
    await screen.findByRole('button', { name: 'Submit' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(records).toEqual([])
    expect(screen.queryByRole('button', { name: /waiting to send/ })).not.toBeInTheDocument()
    expect(await submissionsOf('someone-else')).toHaveLength(1)
  })

  it("the badge sits in the driver app's top bar", async () => {
    await enqueue({ ownerId: ME, ...report(1) })
    signedInAs(driver)
    server.use(
      http.post('/api/v1/dvir-reports', () => HttpResponse.error()),
      http.get('/api/v1/trips', () => envelope([])),
    )
    renderApp('/driver')
    // The shell's top bar: the first banner (the screen has its own header).
    const [bar] = await screen.findAllByRole('banner')
    expect(await within(bar).findByRole('button', { name: '1 waiting to send' })).toBeInTheDocument()
  })
})
