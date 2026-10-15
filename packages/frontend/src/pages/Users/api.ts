import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'

// User and role administration (api-contract §5.1, FMS-78).

export type UserStatus = 'active' | 'inactive' | 'suspended' | 'locked'

export interface User {
  id: string
  email: string
  full_name: string
  phone: string | null
  depot_id: string | null
  status: UserStatus
  roles: string[]
  /** False until the user sets a password through their setup link. */
  has_password: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export interface Role {
  name: string
  description: string | null
  permissions: string[]
}

/** A one-time link to set a password: shown once, never stored by the API. */
export interface PasswordLink {
  token: string
  purpose: 'setup' | 'reset'
  expires_at: string
}

export interface UserFilters {
  search: string
  role: string
  status: UserStatus | ''
  depotId: string
  page: number
  pageSize: number
}

export interface UserInput {
  email: string
  full_name: string
  phone: string | null
  depot_id: string | null
  roles: string[]
}

export type UserPatch = Partial<UserInput> & { status?: UserStatus }

function userQuery(f: UserFilters): string {
  const q = new URLSearchParams({ page: String(f.page), page_size: String(f.pageSize) })
  if (f.search.trim()) q.set('search', f.search.trim())
  if (f.role) q.set('role', f.role)
  if (f.status) q.set('status', f.status)
  if (f.depotId) q.set('depot_id', f.depotId)
  return q.toString()
}

export function useUsers(filters: UserFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['users', 'list', filters],
    queryFn: async () => {
      const { data, meta } = await api.requestEnvelope<User[]>(`/users?${userQuery(filters)}`)
      return { users: data, meta: meta as unknown as PageMeta }
    },
  })
}

/** Totals per status for the stat cards (one tiny request each). */
export function useUserCounts() {
  const { api } = useAuth()
  const figures = { total: '', active: 'active', suspended: 'suspended', locked: 'locked', inactive: 'inactive' }
  const results = useQueries({
    queries: Object.entries(figures).map(([name, status]) => ({
      placeholderData: keepPreviousData,
      queryKey: ['users', 'counts', name],
      queryFn: async () => {
        const q = new URLSearchParams({ page_size: '1' })
        if (status) q.set('status', status)
        return ((await api.requestEnvelope<User[]>(`/users?${q}`)).meta as unknown as PageMeta).total_items
      },
    })),
  })
  const [total, active, suspended, locked, inactive] = results.map((r) => r.data)
  return { counts: { total, active, suspended, locked, inactive }, isLoading: results.some((r) => r.isPending) }
}

export function useRoles(enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['roles'],
    queryFn: () => api.request<Role[]>('/roles'),
    staleTime: 10 * 60_000,
    enabled,
  })
}

/** POST /users: the account, without a password, and its one-time setup link. */
export function useCreateUser() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: UserInput) => {
      const { data, meta } = await api.requestEnvelope<User>('/users', { method: 'POST', json: input })
      return { user: data, link: (meta as { password_setup: PasswordLink }).password_setup }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })
}

export function useUpdateUser() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UserPatch }) => api.request<User>(`/users/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })
}

/** POST /users/{id}/password-reset: a new link; older links stop working. */
export function useIssuePasswordLink() {
  const { api } = useAuth()
  return useMutation({
    mutationFn: (id: string) => api.request<PasswordLink>(`/users/${id}/password-reset`, { method: 'POST' }),
  })
}

/** The body of POST /auth/password. */
export interface NewPassword {
  token: string
  password: string
}

/** POST /auth/password: public, the link is the credential. */
export function useSetPassword() {
  const { api } = useAuth()
  return useMutation({
    mutationFn: (body: NewPassword) => api.request<void>('/auth/password', { method: 'POST', json: body }),
  })
}

/**
 * The address the admin hands to the user. The token travels in the
 * fragment, which browsers never send to a server or in a Referer header.
 */
export function passwordLinkUrl(token: string): string {
  return `${window.location.origin}/set-password#token=${encodeURIComponent(token)}`
}
