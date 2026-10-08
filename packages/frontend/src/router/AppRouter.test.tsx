// Acceptance criteria of FMS-09 (SE-45), end to end through the real router,
// AuthProvider and API client with the network mocked.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { IDLE_TIMEOUT_MS } from '@/context/AuthContext'
import { server } from '@/test/msw/server'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs, signedOut, testApi } from '@/test/auth'

const dispatcher = currentUser(['dispatcher'], ['trip:read'])
const driver = currentUser(['driver'], ['trip:execute', 'fuel:write'])
const financeClerk = currentUser(['finance_clerk'], ['fuel-anomaly:read'])

const location = () => screen.getByTestId('location').textContent

describe('protected routes', () => {
  it('redirects /dashboard without a session to /login?redirect=/dashboard', async () => {
    signedOut()
    renderApp('/dashboard')

    await waitFor(() => expect(location()).toBe('/login?redirect=/dashboard'))
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('keeps the query string of the attempted URL', async () => {
    signedOut()
    renderApp('/dashboard?tab=alerts&depot=2')

    await waitFor(() => expect(location()).toBe('/login?redirect=/dashboard%3Ftab%3Dalerts%26depot%3D2'))
  })

  it('shows nothing from the app while the silent refresh is pending', async () => {
    server.use(http.post('/api/v1/auth/refresh', () => new Promise(() => {})))
    renderApp('/dashboard')

    expect(await screen.findByRole('status')).toHaveTextContent('Checking your session')
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument()
    expect(location()).toBe('/dashboard')
  })

  it('opens the page directly when the silent refresh succeeds', async () => {
    signedInAs(dispatcher)
    renderApp('/dashboard')

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(location()).toBe('/dashboard')
  })

  it('lands each role in its own portal from /', async () => {
    signedInAs(driver)
    const { unmount } = renderApp('/')
    await waitFor(() => expect(location()).toBe('/driver'))
    unmount()

    signedInAs(dispatcher)
    renderApp('/')
    await waitFor(() => expect(location()).toBe('/dashboard'))
  })
})

describe('login redirect', () => {
  it('returns the user to the attempted URL after login', async () => {
    signedOut()
    server.use(http.post('/api/v1/auth/login', () => envelope(dispatcher)))
    renderApp('/dashboard')
    await waitFor(() => expect(location()).toBe('/login?redirect=/dashboard'))

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'sam@fms.local')
    await user.type(screen.getByLabelText('Password'), 'Test-Pass-1')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(location()).toBe('/dashboard')
  })

  it('shows the API message and stays on /login when credentials are wrong', async () => {
    signedOut()
    server.use(http.post('/api/v1/auth/login', () => errorEnvelope(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid email or password.')))
    renderApp('/login?redirect=/dashboard')

    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Email'), 'sam@fms.local')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.')
    expect(location()).toBe('/login?redirect=/dashboard')
  })

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/login?redirect=/login'])(
    'ignores the off-site or looping redirect %s and goes to the portal home',
    async (target) => {
      signedInAs(dispatcher)
      renderApp(`/login?redirect=${encodeURIComponent(target)}`)

      await waitFor(() => expect(location()).toBe('/dashboard'))
    },
  )
})

describe('RoleGate on routes', () => {
  it('renders nothing for a driver on /fuel-reconciliation, not an error', async () => {
    signedInAs(driver)
    renderApp('/fuel-reconciliation')

    await screen.findByText('Sam Tester')
    expect(location()).toBe('/fuel-reconciliation')
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/not found|forbidden|denied/i)).not.toBeInTheDocument()
  })

  it('renders the screen for a user holding the permission', async () => {
    signedInAs(financeClerk)
    renderApp('/fuel-reconciliation')

    expect(await screen.findByRole('heading', { name: 'Fuel Reconciliation' })).toBeInTheDocument()
  })
})

describe('idle logout', () => {
  it('uses a 30 minute limit', () => {
    expect(IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  it('signs out through POST /auth/logout and lands on /login?reason=idle', async () => {
    signedInAs(dispatcher)
    let logoutCalls = 0
    server.use(
      http.post('/api/v1/auth/logout', () => {
        logoutCalls += 1
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderApp('/dashboard', { idleTimeoutMs: 150 })

    await screen.findByRole('heading', { name: 'Dashboard' })
    await waitFor(() => expect(location()).toBe('/login?reason=idle'))
    expect(logoutCalls).toBe(1)
    expect(screen.getByRole('status')).toHaveTextContent('30 minutes of inactivity')
  })

  it('still ends the session when the logout call fails', async () => {
    signedInAs(dispatcher)
    server.use(http.post('/api/v1/auth/logout', () => HttpResponse.error()))
    renderApp('/dashboard', { idleTimeoutMs: 150 })

    await waitFor(() => expect(location()).toBe('/login?reason=idle'))
  })
})

describe('leaving the session', () => {
  it('signs out from the header and returns to /login', async () => {
    signedInAs(dispatcher)
    server.use(http.post('/api/v1/auth/logout', () => new HttpResponse(null, { status: 204 })))
    renderApp('/dashboard')

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(location()).toBe('/login'))
  })

  it('sends the user to /login?redirect= when the server reports the session revoked', async () => {
    signedInAs(dispatcher)
    server.use(http.get('/api/v1/vehicles', () => errorEnvelope(401, 'AUTH_TOKEN_REVOKED')))
    const api = testApi()
    renderApp('/dashboard', { api })
    await screen.findByRole('heading', { name: 'Dashboard' })

    await expect(api.request('/vehicles')).rejects.toMatchObject({ code: 'AUTH_TOKEN_REVOKED' })

    await waitFor(() => expect(location()).toBe('/login?redirect=/dashboard'))
  })
})
