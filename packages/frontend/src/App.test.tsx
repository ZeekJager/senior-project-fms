import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import App from './App'
import { server } from './test/msw/server'

describe('App', () => {
  it('sends a visitor without a session to the sign-in screen', async () => {
    window.history.pushState({}, '', '/dashboard')
    server.use(
      http.post('/api/v1/auth/refresh', () =>
        HttpResponse.json({ error: { code: 'AUTH_TOKEN_INVALID', message: 'No session.' } }, { status: 401 }),
      ),
    )
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(window.location.pathname + window.location.search).toBe('/login?redirect=/dashboard')
  })
})
