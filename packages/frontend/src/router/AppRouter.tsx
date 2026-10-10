import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
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
        <Route element={<AppShell />}>
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
