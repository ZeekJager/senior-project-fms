import { LogOut, PanelLeftClose, PanelLeftOpen, Truck } from 'lucide-react'
import { useCallback, useSyncExternalStore } from 'react'
import { NavLink } from 'react-router-dom'
import { cn, IconButton } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import type { NavSection } from '@/router/navigation'
import type { AppRoute } from '@/router/routes'

const KEY = 'fms-sidebar'
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'collapsed'
  } catch {
    return false
  }
}

let collapsedNow = read()

/** Desktop sidebar: full or an icon rail, remembered on this device. Tablets always get the rail. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const collapsed = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => collapsedNow,
    () => false,
  )
  const toggle = useCallback(() => {
    collapsedNow = !collapsedNow
    try {
      localStorage.setItem(KEY, collapsedNow ? 'collapsed' : 'expanded')
    } catch {
      // Still collapses for this visit.
    }
    listeners.forEach((l) => l())
  }, [])
  return [collapsed, toggle]
}

export function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

/** "fleet_manager" -> "Fleet manager". */
function roleLabel(role: string | undefined): string {
  if (!role) return ''
  const text = role.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Where text is shown: always (menu sheet), from 1024px (full sidebar), or never (collapsed rail). */
const labelClass = (rail: boolean, collapsed: boolean) => (!rail ? '' : collapsed ? 'sr-only' : 'md:sr-only lg:not-sr-only')
const blockClass = (rail: boolean, collapsed: boolean) => (!rail ? '' : collapsed ? 'hidden' : 'md:hidden lg:block')

export function Brand({ compact, onDark, rail = false, collapsed = false }: { compact?: boolean; onDark?: boolean; rail?: boolean; collapsed?: boolean }) {
  return (
    <div className={cn('flex items-center gap-3', rail ? cn('md:justify-center', !collapsed && 'lg:justify-start') : 'px-2')}>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand text-white">
        <Truck className="h-[18px] w-[18px]" aria-hidden="true" />
      </div>
      <div className={cn('min-w-0 leading-tight', blockClass(rail, collapsed))}>
        <p className={cn('text-sm font-semibold tracking-tight', onDark ? 'text-white' : 'text-ink')}>Fleet</p>
        {!compact && <p className={cn('text-xs', onDark ? 'text-side-ink' : 'text-ink-subtle')}>Management System</p>}
      </div>
    </div>
  )
}

export function NavItems({ routes, onNavigate, rail = false, collapsed = false }: { routes: AppRoute[]; onNavigate?: () => void; rail?: boolean; collapsed?: boolean }) {
  return (
    <ul className="space-y-1">
      {routes.map(({ path, nav }) => {
        const Icon = nav!.icon
        return (
          <li key={path}>
            <NavLink
              to={path}
              onClick={onNavigate}
              title={rail ? nav!.label : undefined}
              className={({ isActive }) =>
                cn(
                  'focus-ring group flex h-10 coarse:h-11 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-150 ease-smooth',
                  rail && 'ring-offset-side md:justify-center md:px-0',
                  rail && !collapsed && 'lg:justify-start lg:px-3',
                  rail
                    ? isActive
                      ? 'bg-side-active text-white shadow-soft'
                      : 'text-side-ink hover:bg-white/10 hover:text-white'
                    : isActive
                      ? 'bg-brand-soft text-brand-ink'
                      : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={cn(
                      'h-[18px] w-[18px] shrink-0 transition-colors',
                      rail ? (isActive ? 'text-white' : 'text-side-ink group-hover:text-white') : isActive ? 'text-brand-ink' : 'text-ink-subtle group-hover:text-ink-muted',
                    )}
                    aria-hidden="true"
                  />
                  <span className={cn('truncate', labelClass(rail, collapsed))}>{nav!.label}</span>
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
export function Sections({ sections, onNavigate, rail = false, collapsed = false }: { sections: NavSection[]; onNavigate?: () => void; rail?: boolean; collapsed?: boolean }) {
  return (
    <div className="space-y-6">
      {sections.map(({ portal, routes }) => (
        <section
          key={portal.id}
          aria-labelledby={`nav-${portal.id}`}
          className={cn(rail && 'md:border-t md:border-side-line md:pt-5 md:first:border-t-0 md:first:pt-0', rail && !collapsed && 'lg:border-0 lg:pt-0 lg:first:pt-0')}
        >
          <h2
            id={`nav-${portal.id}`}
            className={cn('mb-2 px-3 text-2xs font-semibold uppercase tracking-wider', rail ? 'text-side-ink/80' : 'text-ink-subtle', labelClass(rail, collapsed))}
          >
            {portal.name}
          </h2>
          <NavItems routes={routes} onNavigate={onNavigate} rail={rail} collapsed={collapsed} />
        </section>
      ))}
    </div>
  )
}

export function UserCard({ rail = false, collapsed = false }: { rail?: boolean; collapsed?: boolean }) {
  const { session, logout } = useAuth()
  const name = session?.user.full_name
  const role = roleLabel(session?.roles?.[0])
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-card p-2.5',
        rail ? cn('border border-side-line bg-white/5 md:flex-col md:gap-2 md:p-2', !collapsed && 'lg:flex-row lg:gap-3 lg:p-2.5') : 'border border-line bg-surface-muted',
      )}
    >
      <div
        className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold', rail ? 'bg-brand text-white' : 'bg-brand-soft text-brand-ink')}
        aria-hidden="true"
        title={rail ? name : undefined}
      >
        {initials(name)}
      </div>
      <div className={cn('min-w-0 flex-1', blockClass(rail, collapsed))}>
        <p className={cn('truncate text-sm font-medium', rail ? 'text-white' : 'text-ink')}>{name}</p>
        <p className={cn('truncate text-xs', rail ? 'text-side-ink' : 'text-ink-subtle')}>{role || session?.user.email}</p>
      </div>
      <IconButton label="Sign out" icon={<LogOut />} size="sm" onClick={() => void logout()} className={rail ? 'text-side-ink hover:bg-white/10 hover:text-white' : undefined} />
    </div>
  )
}

/** The desktop and tablet sidebar. Full from 1024px unless collapsed; an icon rail from 768px. */
export function Sidebar({ sections }: { sections: NavSection[] }) {
  const [collapsed, toggle] = useSidebarCollapsed()
  return (
    <aside
      data-collapsed={collapsed}
      className={cn('fixed inset-y-0 left-0 z-40 hidden w-[72px] flex-col bg-side px-3 py-5 transition-[width] duration-200 ease-smooth md:flex', !collapsed && 'lg:w-64 lg:px-4')}
    >
      <Brand onDark rail collapsed={collapsed} />
      <nav aria-label="Main" className="mt-8 flex-1 overflow-y-auto">
        <Sections sections={sections} rail collapsed={collapsed} />
      </nav>
      <div className="space-y-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="focus-ring hidden h-9 w-full items-center gap-3 rounded-control px-3 text-sm text-side-ink ring-offset-side transition-colors hover:bg-white/10 hover:text-white lg:flex"
        >
          {collapsed ? <PanelLeftOpen className="mx-auto h-[18px] w-[18px]" aria-hidden="true" /> : <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden="true" />}
          {!collapsed && 'Collapse'}
        </button>
        <UserCard rail collapsed={collapsed} />
      </div>
    </aside>
  )
}
