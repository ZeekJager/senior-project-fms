// Helpers for tests that need a signed-in (or signed-out) app.
import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { AuthProvider, type CurrentUser } from '@/context/AuthContext'
import { createApiClient, type ApiClient } from '@/lib/api/client'
import { createQueryClient } from '@/lib/query'
import { AppRouter } from '@/router/AppRouter'
import { server } from './msw/server'

/** An API client whose relative URLs resolve against the jsdom origin, as the browser would. */
export const testApi = () =>
  createApiClient((input, init) => fetch(new URL(String(input), window.location.origin), init))

export function currentUser(roles: string[], permissions: string[]): CurrentUser {
  return {
    user: {
      id: 'u-1',
      email: 'sam@fms.local',
      full_name: 'Sam Tester',
      phone: null,
      status: 'active',
      depot_id: null,
      last_login_at: null,
    },
    roles,
    permissions,
  }
}

export const envelope = (data: unknown) => HttpResponse.json({ data, meta: { request_id: 'r-1' } })

export const errorEnvelope = (
  status: number,
  code: string,
  message = code,
  details?: { field?: string; reason: string }[],
) => HttpResponse.json({ error: { code, message, ...(details ? { details } : {}) }, meta: { request_id: 'r-1' } }, { status })

/** The silent refresh on load succeeds with this user (the session cookie exists). */
export function signedInAs(user: CurrentUser) {
  server.use(http.post('/api/v1/auth/refresh', () => envelope(user)))
}

/** The silent refresh on load is rejected (no session). */
export function signedOut() {
  server.use(http.post('/api/v1/auth/refresh', () => errorEnvelope(401, 'AUTH_TOKEN_INVALID')))
}

export function LocationProbe() {
  const { pathname, search } = useLocation()
  return <div data-testid="location">{pathname + search}</div>
}

export function renderApp(path: string, options: { idleTimeoutMs?: number; api?: ApiClient; children?: ReactNode } = {}) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider api={options.api ?? testApi()} idleTimeoutMs={options.idleTimeoutMs}>
          <LocationProbe />
          <AppRouter />
          {options.children}
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
