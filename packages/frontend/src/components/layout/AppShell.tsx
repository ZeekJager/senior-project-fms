import { LogOut, Menu, Truck } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/shared'
import { cn, Drawer, IconButton, ToastProvider } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { isDriverPortalUser, navSections, portalOf, type NavSection } from '@/router/navigation'
import type { AppRoute } from '@/router/routes'
import { NotificationBell } from './NotificationBell'

function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-2">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand bg-gradient-to-br from-white/20 to-white/0 text-white shadow-glow ring-1 ring-inset ring-white/15">
        <Truck className="h-[18px] w-[18px]" aria-hidden="true" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold tracking-tight text-ink">Fleet</p>
        {!compact && <p className="text-xs text-ink-subtle">Management System</p>}
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
                  isActive ? 'bg-surface text-ink shadow-soft ring-1 ring-line' : 'text-ink-muted hover:bg-surface/60 hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={cn('h-[18px] w-[18px] transition-colors', isActive ? 'text-brand-ink' : 'text-ink-subtle group-hover:text-ink-muted')} aria-hidden="true" />
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

/** The menu, one titled group per portal the user may use. */
function Sections({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  return (
    <div className="space-y-6">
      {sections.map(({ portal, routes }) => (
        <section key={portal.id} aria-labelledby={`nav-${portal.id}`}>
          <h2 id={`nav-${portal.id}`} className="mb-2 px-3 text-2xs font-medium uppercase tracking-wider text-ink-subtle">
            {portal.name}
          </h2>
          <NavItems routes={routes} onNavigate={onNavigate} />
        </section>
      ))}
    </div>
  )
}

function UserCard() {
  const { session, logout } = useAuth()
  const name = session?.user.full_name
  return (
    <div className="flex items-center gap-3 rounded-card border border-line bg-surface/70 p-2.5 shadow-soft">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand/80 to-purple-500/80 text-xs font-semibold text-white" aria-hidden="true">
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

function SkipLink() {
  return (
    <a href="#main" className="sr-only z-[70] rounded-control bg-surface px-4 py-2 shadow-elevated focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
      Skip to content
    </a>
  )
}

function Content({ className }: { className: string }) {
  const location = useLocation()
  return (
    <main id="main" className={className}>
      <ErrorBoundary resetKey={location.pathname}>
        <Outlet />
      </ErrorBoundary>
    </main>
  )
}

/**
 * Staff portals (fleet management, command center, administration): a
 * frosted sidebar grouped by portal from 1024px, a top bar with the current
 * portal and the notification bell at every width, and a slide-in menu below
 * 1024px.
 */
function StaffShell({ sections }: { sections: NavSection[] }) {
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const portal = portalOf(location.pathname)

  return (
    <div className="min-h-screen text-ink">
      <SkipLink />
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-line bg-surface-muted/60 px-4 py-6 backdrop-blur-xl lg:flex">
        <Brand />
        <nav aria-label="Main" className="mt-8 flex-1 overflow-y-auto">
          <Sections sections={sections} />
        </nav>
        <UserCard />
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-line bg-surface/75 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <div className="lg:hidden">
            <Brand compact />
          </div>
          <p className="hidden text-sm font-medium text-ink-muted lg:block">{portal?.name ?? ''}</p>
          <div className="flex items-center gap-1">
            <NotificationBell />
            <IconButton label="Open menu" icon={<Menu />} onClick={() => setMenuOpen(true)} className="lg:hidden" />
          </div>
        </header>
        <Content className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-10" />
      </div>

      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} side="left" title="Menu" hideTitle footer={<div className="w-full"><UserCard /></div>}>
        <nav aria-label="Main">
          <Sections sections={sections} onNavigate={() => setMenuOpen(false)} />
        </nav>
      </Drawer>
    </div>
  )
}

/**
 * The driver portal: built for a phone in a cab. A compact top bar (bell,
 * account), one column, large targets, and a bottom tab bar once the driver
 * portal has more than one screen (S-11 to S-14).
 */
function DriverShell({ routes }: { routes: AppRoute[] }) {
  const { session } = useAuth()
  const [accountOpen, setAccountOpen] = useState(false)
  const tabs = routes.length > 1

  return (
    <div className="min-h-screen text-ink">
      <SkipLink />
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/80 px-3 backdrop-blur-xl">
        <Brand compact />
        <div className="flex items-center gap-1">
          <NotificationBell />
          <button
            type="button"
            onClick={() => setAccountOpen(true)}
            aria-label="Account"
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand/80 to-purple-500/80 text-xs font-semibold text-white"
          >
            {initials(session?.user.full_name)}
          </button>
        </div>
      </header>

      <Content className={cn('mx-auto w-full max-w-lg px-4 py-5', tabs && 'pb-24')} />

      {tabs && (
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
          <ul className="mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${routes.length}, minmax(0, 1fr))` }}>
            {routes.map(({ path, nav }) => {
              const Icon = nav!.icon
              return (
                <li key={path}>
                  <NavLink
                    to={path}
                    className={({ isActive }) =>
                      cn('focus-ring flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium', isActive ? 'text-brand-ink' : 'text-ink-subtle')
                    }
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                    {nav!.label}
                  </NavLink>
                </li>
              )
            })}
          </ul>
        </nav>
      )}

      <Drawer open={accountOpen} onClose={() => setAccountOpen(false)} title="Account" footer={<div className="w-full"><UserCard /></div>}>
        {!tabs && (
          <nav aria-label="Main">
            <NavItems routes={routes} onNavigate={() => setAccountOpen(false)} />
          </nav>
        )}
      </Drawer>
    </div>
  )
}

/** The signed-in frame: the driver portal's mobile layout for drivers, the staff portals for everyone else (FMS-114). */
export function AppShell() {
  const { session } = useAuth()
  const viewer = session ?? { roles: [], permissions: [] }
  const sections = navSections(viewer)

  return (
    <ToastProvider>
      {isDriverPortalUser(viewer) ? <DriverShell routes={sections.flatMap((s) => s.routes)} /> : <StaffShell sections={sections} />}
    </ToastProvider>
  )
}
