import type { ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'

interface RoleGateProps {
  /** A permission code from /auth/me, or a list of which any one is enough. Never a role name. */
  permission: string | readonly string[]
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
