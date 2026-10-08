import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { RoleGate } from '@/components/RoleGate'
import { useAuth } from '@/context/AuthContext'
import { LoginPage } from '@/pages/Login'
import { NotFoundPage } from '@/pages/placeholders'
import { homePathFor } from './redirect'
import { portals } from './routes'

// The shared-components examples page exists only under `vite` dev. In a
// production build `import.meta.env.DEV` is false, so the import is dropped
// and the page is not in the bundle.
const UiExamples = import.meta.env.DEV ? lazy(() => import('@/pages/dev/UiExamples')) : null

function Shell() {
  const { session, logout } = useAuth()
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <span className="font-semibold text-fms-primary">Fleet Management System</span>
        <span className="flex items-center gap-4">
          <span>{session?.user.full_name}</span>
          <button type="button" onClick={() => void logout()} className="underline">
            Sign out
          </button>
        </span>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  )
}

function Home() {
  const { session } = useAuth()
  return <Navigate to={homePathFor(session?.roles ?? [])} replace />
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {UiExamples && (
        <Route
          path="/dev/ui"
          element={
            <Suspense fallback={null}>
              <UiExamples />
            </Suspense>
          }
        />
      )}
      <Route element={<ProtectedRoute />}>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          {portals
            .flatMap((portal) => portal.routes)
            .map(({ path, element, permission }) => (
              <Route
                key={path}
                path={path}
                element={permission ? <RoleGate permission={permission}>{element}</RoleGate> : element}
              />
            ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
