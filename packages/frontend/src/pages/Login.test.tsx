// Acceptance criteria of FMS-10 (SE-46).
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/test/msw/server'
import { currentUser, envelope, errorEnvelope, renderApp, signedOut } from '@/test/auth'

const location = () => screen.getByTestId('location').textContent

async function openLogin(path = '/login') {
  signedOut()
  renderApp(path)
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Sign in' })
  return user
}

async function fill(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  if (email) await user.type(screen.getByLabelText('Email'), email)
  if (password) await user.type(screen.getByLabelText('Password'), password)
}

const submit = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Sign in' }))

function countLogins() {
  const calls = { n: 0 }
  server.use(
    http.post('/api/v1/auth/login', () => {
      calls.n += 1
      return errorEnvelope(401, 'AUTH_INVALID_CREDENTIALS', 'server wording that must not be shown')
    }),
  )
  return calls
}

describe('Login screen', () => {
  it('shows a required error for an empty email before any API call', async () => {
    const calls = countLogins()
    const user = await openLogin()

    await fill(user, '', 'secret')
    await submit(user)

    expect(screen.getByText('Enter your email.')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(calls.n).toBe(0)
  })

  it('shows a required error for an empty password before any API call', async () => {
    const calls = countLogins()
    const user = await openLogin()

    await fill(user, 'sam@fms.local', '')
    await submit(user)

    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
    expect(calls.n).toBe(0)
  })

  it('treats a whitespace-only email as empty', async () => {
    const calls = countLogins()
    const user = await openLogin()

    await fill(user, '   ', 'secret')
    await submit(user)

    expect(screen.getByText('Enter your email.')).toBeInTheDocument()
    expect(calls.n).toBe(0)
  })

  it('renders the generic message for a wrong password, never naming the field', async () => {
    countLogins()
    const user = await openLogin()

    await fill(user, 'sam@fms.local', 'wrong')
    await submit(user)

    const alert = await screen.findByText('Invalid email or password.')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(screen.queryByText(/not found|server wording/i)).not.toBeInTheDocument()
  })

  it('renders the disabled-account message', async () => {
    server.use(http.post('/api/v1/auth/login', () => errorEnvelope(403, 'AUTH_ACCOUNT_DISABLED')))
    const user = await openLogin()

    await fill(user, 'sam@fms.local', 'right')
    await submit(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your account has been disabled. Contact your administrator.',
    )
  })

  it('renders a throttling message on 429 and a generic one when the server is unreachable', async () => {
    server.use(http.post('/api/v1/auth/login', () => errorEnvelope(429, 'RATE_LIMITED')))
    const user = await openLogin()
    await fill(user, 'sam@fms.local', 'x')
    await submit(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sign-in attempts')

    server.use(http.post('/api/v1/auth/login', () => HttpResponse.error()))
    await submit(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not sign in. Try again.'))
  })

  it('disables the button with a spinner during the call, so a second click sends nothing', async () => {
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.use(
      http.post('/api/v1/auth/login', async () => {
        calls += 1
        await gate
        return envelope(currentUser(['dispatcher'], []))
      }),
    )
    const user = await openLogin()
    await fill(user, 'sam@fms.local', 'right')
    await submit(user)

    const busy = await screen.findByRole('button', { name: 'Signing in…' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy.querySelector('svg.animate-spin')).not.toBeNull()
    await user.click(busy)
    await user.keyboard('{Enter}')

    release()
    await screen.findByRole('heading', { name: 'Dashboard' })
    expect(calls).toBe(1)
  })

  it('lets the user try again after a failure', async () => {
    countLogins()
    const user = await openLogin()
    await fill(user, 'sam@fms.local', 'wrong')
    await submit(user)
    await screen.findByText('Invalid email or password.')

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('redirects to the ?redirect= page after a successful login', async () => {
    server.use(http.post('/api/v1/auth/login', () => envelope(currentUser(['finance_clerk'], ['fuel-anomaly:read']))))
    const user = await openLogin('/login?redirect=/fuel-reconciliation')

    await fill(user, 'sam@fms.local', 'right')
    await submit(user)

    expect(await screen.findByRole('heading', { name: 'Fuel Reconciliation' })).toBeInTheDocument()
    expect(location()).toBe('/fuel-reconciliation')
  })

  it('redirects to /dashboard when there is no ?redirect=', async () => {
    server.use(http.post('/api/v1/auth/login', () => envelope(currentUser(['dispatcher'], []))))
    const user = await openLogin()

    await fill(user, 'sam@fms.local', 'right')
    await submit(user)

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(location()).toBe('/dashboard')
  })

  it('submits with Enter from the password field', async () => {
    server.use(http.post('/api/v1/auth/login', () => envelope(currentUser(['dispatcher'], []))))
    const user = await openLogin()

    await fill(user, 'sam@fms.local', 'right')
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
  })

  it('has no Forgot password or Sign up flow', async () => {
    await openLogin()

    expect(screen.queryByText(/forgot|sign up|register|create account/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  describe('accessibility', () => {
    it('associates labels with inputs and sets the autocomplete hints', async () => {
      await openLogin()

      expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email')
      expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email')
      expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
      expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    })

    it('announces errors through live regions that exist before the error does', async () => {
      const user = await openLogin()
      const emailRegion = document.getElementById('login-email-error')
      expect(emailRegion).toHaveAttribute('aria-live', 'polite')
      expect(screen.getByRole('alert')).toBeEmptyDOMElement()

      await submit(user)

      // Same elements, now filled: assistive technology announces the change.
      expect(document.getElementById('login-email-error')).toBe(emailRegion)
      expect(emailRegion).toHaveTextContent('Enter your email.')
      expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter your email.')
    })

    it('shows the idle sign-out notice as a status message', async () => {
      await openLogin('/login?reason=idle')

      expect(screen.getByRole('status')).toHaveTextContent('signed out after 30 minutes of inactivity')
    })
  })
})
