import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { AuditEntry } from './describe'

// GET /audit-logs (api-contract §5.2, FMS-28), read by S-10 (FMS-29). audit:read only.

export type AuditView = 'changes' | 'signins' | 'denied' | 'jobs' | 'all'

/** What each view asks the API for: a set of actions (exact or `prefix.*`), or a result. */
export const VIEW_QUERY: Record<AuditView, { action?: string; result?: string }> = {
  changes: { action: 'INSERT,UPDATE,DELETE,ROLE_CHANGE' },
  signins: { action: 'auth.*' },
  denied: { result: 'denied' },
  jobs: { action: 'job.*' },
  all: {},
}

export const AUDIT_PAGE_SIZE = 50

/** The screen's state, kept in the URL so an audit question can be shared as a link. */
export interface AuditFilters {
  view: AuditView
  /** A schema-qualified table, e.g. fleet.vehicles. */
  table: string
  /** Public ids: the record, the person who acted, and the request (correlation id). */
  record: string
  user: string
  request: string
  /** Addis Ababa days, YYYY-MM-DD; `to` includes its day. */
  from: string
  to: string
}

const VIEWS: readonly AuditView[] = ['changes', 'signins', 'denied', 'jobs', 'all']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TABLE = /^[a-z_]+\.[a-z_]+$/

export const isUuid = (value: string) => UUID.test(value.trim())

export function readFilters(p: URLSearchParams): AuditFilters {
  const view = p.get('view') as AuditView | null
  const id = (key: string) => (isUuid(p.get(key) ?? '') ? p.get(key)!.trim().toLowerCase() : '')
  const day = (key: string) => (DATE.test(p.get(key) ?? '') ? p.get(key)! : '')
  return {
    view: view && VIEWS.includes(view) ? view : 'changes',
    table: TABLE.test(p.get('table') ?? '') ? p.get('table')! : '',
    record: id('record'),
    user: id('user'),
    request: id('request'),
    from: day('from'),
    to: day('to'),
  }
}

/** Defaults stay out of the URL: the plain address is every data change, newest first. */
export function writeFilters(f: AuditFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.view !== 'changes') p.set('view', f.view)
  for (const key of ['table', 'record', 'user', 'request', 'from', 'to'] as const) if (f[key]) p.set(key, f[key])
  return p
}

/** One page of the trail, newest first, from `cursor` (null: the first page). */
export function useAuditLog(f: AuditFilters, cursor: string | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['audit-logs', f, cursor],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const q = new URLSearchParams({ page_size: String(AUDIT_PAGE_SIZE) })
      const { action, result } = VIEW_QUERY[f.view]
      if (action) q.set('action', action)
      if (result) q.set('result', result)
      if (f.table) q.set('entity_type', f.table)
      if (f.record) q.set('entity_id', f.record)
      if (f.user) q.set('user_id', f.user)
      if (f.request) q.set('correlation_id', f.request)
      if (f.from) q.set('from', f.from)
      if (f.to) q.set('to', f.to)
      if (cursor) q.set('cursor', cursor)
      const { data, meta } = await api.requestEnvelope<AuditEntry[]>(`/audit-logs?${q}`)
      return { entries: data, nextCursor: (meta as { next_cursor?: string | null }).next_cursor ?? null }
    },
  })
}
