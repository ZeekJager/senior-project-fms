import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api as defaultApi, type ApiClient } from '@/lib/api/client'
import { useIdleTimeout } from '@/hooks/useIdleTimeout'

/** Sign out after this long without input (SRS session policy). */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** Body of `/auth/login`, `/auth/refresh` and `/auth/me` (docs/auth.md). */
export interface CurrentUser {
  user: {
    id: string
    email: string
    full_name: string
    phone: string | null
    status: string
    depot_id: string | null
    last_login_at: string | null
  }
  roles: string[]
  permissions: string[]
}

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

export interface AuthContextValue {
  status: AuthStatus
  session: CurrentUser | null
  /** Throws ApiError (AUTH_INVALID_CREDENTIALS, AUTH_ACCOUNT_DISABLED, RATE_LIMITED, ...) for the login form to show. */
  login(email: string, password: string): Promise<void>
  logout(options?: { reason?: 'idle' }): Promise<void>
  hasPermission(permission: string | readonly string[]): boolean
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

interface AuthProviderProps {
  children: ReactNode
  api?: ApiClient
  idleTimeoutMs?: number
}

/**
 * Holds who is signed in. The tokens are HttpOnly cookies the page cannot
 * read, so nothing secret is stored here: only the current user, in memory
 * (never in localStorage). On load it asks the server whether a session
 * survives, using the refresh cookie.
 */
export function AuthProvider({ children, api = defaultApi, idleTimeoutMs = IDLE_TIMEOUT_MS }: AuthProviderProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [session, setSession] = useState<CurrentUser | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')

  // Silent refresh on load. /auth/refresh answers with the current user, the
  // same body as /auth/me, so a second call would add nothing. Concurrent
  // refreshes are shared by the client (React StrictMode runs this twice).
  useEffect(() => {
    let cancelled = false
    api
      .refresh<CurrentUser>()
      .then((current) => {
        if (cancelled) return
        setSession(current)
        setStatus('authenticated')
      })
      .catch(() => {
        if (cancelled) return
        setSession(null)
        setStatus('unauthenticated')
      })
    return () => {
      cancelled = true
    }
  }, [api])

  // The client reports a session it could not recover (second 401, revoked
  // token). ProtectedRoute then sends the user to /login?redirect=.
  useEffect(
    () =>
      api.onSessionEnded(() => {
        setSession(null)
        setStatus('unauthenticated')
        queryClient.clear()
      }),
    [api, queryClient],
  )

  const login = useCallback(
    async (email: string, password: string) => {
      const current = await api.request<CurrentUser>('/auth/login', { method: 'POST', json: { email, password } })
      setSession(current)
      setStatus('authenticated')
    },
    [api],
  )

  const logout = useCallback(
    async (options?: { reason?: 'idle' }) => {
      try {
        await api.request('/auth/logout', { method: 'POST' })
      } catch {
        // The server is unreachable or already forgot us. Either way this
        // browser is done: signing out must never fail visibly.
      }
      setSession(null)
      setStatus('unauthenticated')
      queryClient.clear()
      navigate(options?.reason ? `/login?reason=${options.reason}` : '/login', { replace: true })
    },
    [api, navigate, queryClient],
  )

  useIdleTimeout(status === 'authenticated', idleTimeoutMs, () => void logout({ reason: 'idle' }))

  const hasPermission = useCallback(
    (permission: string | readonly string[]) => {
      if (!session) return false
      const wanted = typeof permission === 'string' ? [permission] : permission
      return wanted.some((code) => session.permissions.includes(code))
    },
    [session],
  )

  const value = useMemo(
    () => ({ status, session, login, logout, hasPermission }),
    [status, session, login, logout, hasPermission],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
