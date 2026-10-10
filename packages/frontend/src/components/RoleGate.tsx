import type { ReactNode } from 'react'
import { useAuth, type PermissionRule } from '@/context/AuthContext'

interface RoleGateProps {
  /** A permission code from /auth/me, a list of which any one is enough, or `{ all: [...] }`. Never a role name. */
  permission: PermissionRule
  children: ReactNode
}

/**
 * Renders its children only for a user holding the permission, and nothing
 * at all otherwise (not a disabled control, not an error). This is a
 * convenience: the API enforces the same permission on every request.
 */
export function RoleGate({ permission, children }: RoleGateProps) {
  const { hasPermission } = useAuth()
  return hasPermission(permission) ? <>{children}</> : null
}
