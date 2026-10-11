import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { errorEnvelope, renderApp, signedOut } from '@/test/auth'
import { server } from '@/test/msw/server'

describe('Set password (one-time link)', () => {
  it('sets the password with the token from the fragment, then removes the token from the address', async () => {
    signedOut()
    let sent: unknown
    server.use(
      http.post('/api/v1/auth/password', async ({ request }) => {
        sent = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderApp('/set-password#token=tok_abc123')
    const u = userEvent.setup()
    await u.type(await screen.findByLabelText('New password'), 'short')
    await u.type(screen.getByLabelText('Repeat the password'), 'short')
    await u.click(screen.getByRole('button', { name: 'Save password' }))
    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument()
    expect(sent).toBeUndefined()

    await u.clear(screen.getByLabelText('New password'))
    await u.clear(screen.getByLabelText('Repeat the password'))
    await u.type(screen.getByLabelText('New password'), 'correct horse battery')
    await u.type(screen.getByLabelText('Repeat the password'), 'correct horse battery')
    await u.click(screen.getByRole('button', { name: 'Save password' }))

    expect(await screen.findByRole('heading', { name: 'Password saved' })).toBeInTheDocument()
    expect(sent).toEqual({ token: 'tok_abc123', password: 'correct horse battery' })
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/set-password$/)
  })

  it('says so when the link is used or expired, and shows password rules from the server on the field', async () => {
    signedOut()
    let calls = 0
    server.use(
      http.post('/api/v1/auth/password', () => {
        calls += 1
        return calls === 1
          ? errorEnvelope(400, 'VALIDATION_FAILED', 'Choose…', [{ field: 'password', reason: 'contains_email' }])
          : errorEnvelope(400, 'VALIDATION_FAILED', 'Invalid', [{ field: 'token', reason: 'invalid_or_expired' }])
      }),
    )
    renderApp('/set-password#token=used')
    const u = userEvent.setup()
    await u.type(await screen.findByLabelText('New password'), 'hanna-at-work-2026')
    await u.type(screen.getByLabelText('Repeat the password'), 'hanna-at-work-2026')
    await u.click(screen.getByRole('button', { name: 'Save password' }))
    expect(await screen.findByText(/does not contain your email/)).toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Save password' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This link is not valid or has expired'))
  })

  it('without a token, explains and disables the form', async () => {
    signedOut()
    renderApp('/set-password')
    expect(await screen.findByRole('alert')).toHaveTextContent('This link is not valid or has expired')
    expect(screen.getByRole('button', { name: 'Save password' })).toBeDisabled()
  })
})
