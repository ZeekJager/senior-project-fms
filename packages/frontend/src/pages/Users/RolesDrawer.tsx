import { ShieldCheck } from 'lucide-react'
import { Drawer, Skeleton } from '@/components/ui'
import { useRoles } from './api'
import { groupPermissions, roleLabel } from './roles'

/** Every role and what it allows (GET /roles), so admins know what they grant. */
export function RolesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const roles = useRoles(open)
  return (
    <Drawer open={open} onClose={onClose} title="Roles and permissions" description="What each role allows. Permissions are checked by the server on every request.">
      {roles.isPending ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : roles.isError ? (
        <p className="text-sm text-danger">Could not load the roles. Close this panel and try again.</p>
      ) : (
        <ul className="space-y-3">
          {(roles.data ?? []).map((role) => (
            <li key={role.name}>
              <details className="group rounded-card border border-line bg-surface shadow-soft open:shadow-card">
                <summary className="focus-ring flex cursor-pointer list-none items-center gap-3 rounded-card p-4 [&::-webkit-details-marker]:hidden">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand-ink ring-1 ring-inset ring-brand/20">
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-ink">{roleLabel(role.name)}</span>
                    {role.description && <span className="block truncate text-xs text-ink-subtle">{role.description}</span>}
                  </span>
                  <span className="tabular shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-muted">{role.permissions.length} permissions</span>
                </summary>
                <dl className="grid gap-x-4 gap-y-2 border-t border-line px-4 py-3 text-xs sm:grid-cols-[120px_1fr]">
                  {groupPermissions(role.permissions).map(([resource, actions]) => (
                    <div key={resource} className="contents">
                      <dt className="font-medium text-ink-muted">{resource}</dt>
                      <dd className="flex flex-wrap gap-1">
                        {actions.map((a) => (
                          <span key={a} className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink">
                            {a}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  )
}
