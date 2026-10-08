import { Navigate, Outlet, useLocation } from 'react-router-dom'
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
      <p role="status" className="p-6 text-slate-500">
        Checking your session…
      </p>
    )
  }
  if (status === 'unauthenticated') {
    return <Navigate to={loginPathFor(location.pathname + location.search + location.hash)} replace />
  }
  return <Outlet />
}
