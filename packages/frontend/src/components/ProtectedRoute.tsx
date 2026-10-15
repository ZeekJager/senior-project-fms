import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Spinner } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { loginPathFor } from '@/router/redirect'

/**
 * Layout route for every screen except /login. While the silent refresh is
 * in flight nothing from the app renders; with no session the visitor is
 * sent to /login?redirect=<where they were going>.
 */
export function ProtectedRoute() {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-ink-muted">
        <Spinner className="h-5 w-5" />
        <p role="status" className="text-sm">
          Checking your session…
        </p>
      </div>
    )
  }
  if (status === 'unauthenticated') {
    return <Navigate to={loginPathFor(location.pathname + location.search + location.hash)} replace />
  }
  return <Outlet />
}
