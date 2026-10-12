import { Menu } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/shared'
import { cn, Drawer, IconButton, ToastProvider } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { isDriverPortalUser, navSections, portalOf, type NavSection } from '@/router/navigation'
import type { AppRoute } from '@/router/routes'
import { NotificationBell } from './NotificationBell'
import { Brand, initials, NavItems, Sections, Sidebar, useSidebarCollapsed, UserCard } from './Sidebar'
import { ThemeToggle } from './ThemeToggle'

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
  const [collapsed] = useSidebarCollapsed()
  const portal = portalOf(location.pathname)

  return (
    <div className="min-h-screen text-ink">
      <SkipLink />
      <Sidebar sections={sections} />

      <div className={cn('transition-[padding] duration-200 ease-smooth md:pl-[72px]', !collapsed && 'lg:pl-64')}>
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-surface px-4 sm:px-6 lg:px-8">
          <div className="md:hidden">
            <Brand compact />
          </div>
          <p className="hidden text-sm font-semibold text-ink md:block">{portal?.name ?? ''}</p>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <NotificationBell />
            <IconButton label="Open menu" icon={<Menu />} onClick={() => setMenuOpen(true)} className="md:hidden" />
          </div>
        </header>
        <Content className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8" />
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
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface px-3">
        <Brand compact />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <NotificationBell />
          <button
            type="button"
            onClick={() => setAccountOpen(true)}
            aria-label="Account"
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink"
          >
            {initials(session?.user.full_name)}
          </button>
        </div>
      </header>

      <Content className={cn('mx-auto w-full max-w-lg px-4 py-5', tabs && 'pb-24')} />

      {tabs && (
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
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
