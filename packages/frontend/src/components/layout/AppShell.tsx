import { LogOut, Menu, Truck } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/shared'
import { cn, Drawer, IconButton, ToastProvider } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { portals, type AppRoute } from '@/router/routes'

function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

function Brand() {
  return (
    <div className="flex items-center gap-3 px-2">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand bg-gradient-to-br from-white/20 to-white/0 text-white shadow-glow ring-1 ring-inset ring-white/15">
        <Truck className="h-[18px] w-[18px]" aria-hidden="true" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold tracking-tight text-ink">Fleet</p>
        <p className="text-xs text-ink-subtle">Management System</p>
      </div>
    </div>
  )
}

function NavItems({ routes, onNavigate }: { routes: AppRoute[]; onNavigate?: () => void }) {
  return (
    <ul className="space-y-1">
      {routes.map(({ path, nav }) => {
        const Icon = nav!.icon
        return (
          <li key={path}>
            <NavLink
              to={path}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'focus-ring group flex h-10 items-center gap-3 rounded-control px-3 text-sm font-medium transition-all duration-150 ease-smooth',
                  isActive
                    ? 'bg-surface text-ink shadow-soft ring-1 ring-line'
                    : 'text-ink-muted hover:bg-surface/60 hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={cn('h-[18px] w-[18px] transition-colors', isActive ? 'text-brand-ink' : 'text-ink-subtle group-hover:text-ink-muted')}
                    aria-hidden="true"
                  />
                  {nav!.label}
                </>
              )}
            </NavLink>
          </li>
        )
      })}
    </ul>
  )
}

function UserCard() {
  const { session, logout } = useAuth()
  const name = session?.user.full_name
  return (
    <div className="flex items-center gap-3 rounded-card border border-line bg-surface/70 p-2.5 shadow-soft">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand/80 to-purple-500/80 text-xs font-semibold text-white"
        aria-hidden="true"
      >
        {initials(name)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{name}</p>
        <p className="truncate text-xs text-ink-subtle">{session?.user.email}</p>
      </div>
      <IconButton label="Sign out" icon={<LogOut />} size="sm" onClick={() => void logout()} />
    </div>
  )
}

/**
 * The signed-in frame: a frosted sidebar with the screens this user may open
 * (from the route table, filtered by permission) and the account, collapsing
 * to a top bar with a slide-in menu below 1024px.
 */
export function AppShell() {
  const { hasPermission } = useAuth()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const navRoutes = portals
    .flatMap((portal) => portal.routes)
    .filter((route) => route.nav && (!route.permission || hasPermission(route.permission)))

  return (
    <ToastProvider>
      <div className="min-h-screen text-ink">
        <a
          href="#main"
          className="sr-only z-[70] rounded-control bg-surface px-4 py-2 shadow-elevated focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to content
        </a>

        <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-line bg-surface-muted/60 px-4 py-6 backdrop-blur-xl lg:flex">
          <Brand />
          <nav aria-label="Main" className="mt-8 flex-1">
            <p className="mb-2 px-3 text-2xs font-medium uppercase tracking-wider text-ink-subtle">Workspace</p>
            <NavItems routes={navRoutes} />
          </nav>
          <UserCard />
        </aside>

        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-line bg-surface/75 px-4 backdrop-blur-xl lg:hidden">
          <Brand />
          <IconButton label="Open menu" icon={<Menu />} onClick={() => setMenuOpen(true)} />
        </header>
        <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} side="left" title="Menu" hideTitle footer={<div className="w-full"><UserCard /></div>}>
          <nav aria-label="Main">
            <NavItems routes={navRoutes} onNavigate={() => setMenuOpen(false)} />
          </nav>
        </Drawer>

        <div className="lg:pl-64">
          <main id="main" className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
