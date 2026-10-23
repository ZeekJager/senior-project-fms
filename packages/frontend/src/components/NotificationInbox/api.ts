import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'
import { useRealtimeEvent, useRealtimeStatus } from '@/lib/realtime/context'

// Server state for the notification inbox (FMS-49, S-17), over FMS-48's API: the caller's own in-app
// notifications of the last 30 days, and their unread count.

/** A notification as GET /notifications returns it (api-contract §12.1). */
export interface InboxNotification {
  id: string
  /** `alert` or `alert_escalated`. */
  type: string
  title: string
  message: string
  alert_id: string | null
  /** What the alert is about, so the click can open the right screen. */
  entity: { type: string; id: string } | null
  vehicle_id: string | null
  driver_id: string | null
  read: boolean
  read_at: string | null
  created_at: string
}

export interface Inbox {
  /** The newest few, newest first. */
  items: InboxNotification[]
  /** In the last 30 days, all of them (not just the ones listed). */
  total: number
  /** The whole inbox's unread count: what the bell's badge shows. */
  unread: number
}

export const INBOX_KEY = ['notifications', 'inbox'] as const

/** How many the panel lists; the rest are older and one scroll away is not what a bell is for. */
export const PANEL_SIZE = 20

/** Without a live socket the inbox is re-read this often. */
const POLL_MS = 60_000

/**
 * The caller's inbox. Kept current three ways: the socket's `notifications.unread` sets the badge at once
 * (the event carries the count) and re-reads the list for the new rows; every change made here is applied to
 * the cache before the server answers; and without a live socket it polls. Events are hints, so a reconnect
 * re-reads it too (the provider marks `['notifications']` stale).
 */
export function useInbox() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  const status = useRealtimeStatus()

  useRealtimeEvent('notifications.unread', (payload) => {
    const count = (payload as { unread_count?: unknown } | null)?.unread_count
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) {
      queryClient.setQueryData<Inbox>(INBOX_KEY, (inbox) => (inbox ? { ...inbox, unread: count } : inbox))
    }
    void queryClient.invalidateQueries({ queryKey: INBOX_KEY })
  })

  return useQuery({
    queryKey: INBOX_KEY,
    queryFn: async (): Promise<Inbox> => {
      const { data, meta } = await api.requestEnvelope<InboxNotification[]>(`/notifications?page_size=${PANEL_SIZE}`)
      const page = meta as unknown as PageMeta & { unread_count: number }
      return { items: data, total: page.total_items, unread: page.unread_count }
    },
    refetchInterval: status === 'live' ? false : POLL_MS,
  })
}

/** Applies a change to the cached inbox, and returns what was there so a failure can put it back. */
function applyToCache(queryClient: QueryClient, change: (inbox: Inbox) => Inbox): Inbox | undefined {
  const before = queryClient.getQueryData<Inbox>(INBOX_KEY)
  if (before) queryClient.setQueryData<Inbox>(INBOX_KEY, change(before))
  return before
}

/** PATCH /notifications/{id}/read: the row reads as read and the badge drops at once. */
export function useMarkRead() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.request<InboxNotification>(`/notifications/${id}/read`, { method: 'PATCH' }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: INBOX_KEY })
      return {
        before: applyToCache(queryClient, (inbox) => {
          const target = inbox.items.find((n) => n.id === id)
          if (!target || target.read) return inbox
          return { ...inbox, unread: Math.max(0, inbox.unread - 1), items: inbox.items.map((n) => (n.id === id ? { ...n, read: true } : n)) }
        }),
      }
    },
    onError: (_err, _id, context) => {
      if (context?.before) queryClient.setQueryData(INBOX_KEY, context.before)
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: INBOX_KEY }),
  })
}

/** POST /notifications/read-all: everything reads as read and the badge goes to 0 at once. */
export function useMarkAllRead() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.request<{ updated: number }>('/notifications/read-all', { method: 'POST' }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: INBOX_KEY })
      return { before: applyToCache(queryClient, (inbox) => ({ ...inbox, unread: 0, items: inbox.items.map((n) => ({ ...n, read: true })) })) }
    },
    onError: (_err, _vars, context) => {
      if (context?.before) queryClient.setQueryData(INBOX_KEY, context.before)
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: INBOX_KEY }),
  })
}
