import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '@/context/AuthContext'
import { RealtimeContext, type RealtimeHandler as Handler, type RealtimeStatus } from './context'

/** Where the API's socket server answers (FMS-43); the dev server proxies it like the rest of /api. */
export const SOCKET_PATH = '/api/v1/socket.io'

/**
 * What each server event makes stale (api-contract §11.2). Events are hints:
 * the screens showing that data re-read it over the API, with its own
 * permissions and scope, so an event never has to carry a whole record.
 */
const STALE: Record<string, readonly (readonly string[])[]> = {
  'trip.updated': [['dispatch'], ['driver', 'today'], ['trips']],
  'vehicle.status.changed': [['dispatch'], ['vehicles']],
  'alert.created': [['alerts'], ['notifications']],
  'alert.updated': [['alerts'], ['notifications']],
  'incident.created': [['incidents']],
}

/** A refused handshake that a renewed session can fix (the access token ran out). */
const RENEWABLE = ['AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID']
/** Renewals in a row without getting connected before giving up until the next sign-in. */
const MAX_RENEWALS = 3

const connectToApi = (): Socket => io({ path: SOCKET_PATH, withCredentials: true, autoConnect: false })

/**
 * Live updates (FMS-43) while signed in: one socket to the API, opened with
 * the session cookie. It reconnects on its own after a network drop. When the
 * server closes it (the access token ran out, or the account changed) or
 * refuses the handshake for an expired token, the session is renewed and the
 * socket opens again; the server decides afresh what this user may hear.
 * Polling stays as the fallback: a screen still refreshes on its own timer.
 */
export function RealtimeProvider({ children, connect = connectToApi }: { children: ReactNode; connect?: () => Socket }) {
  const { status: auth, api } = useAuth()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<RealtimeStatus>('off')
  const handlers = useRef(new Map<string, Set<Handler>>())

  useEffect(() => {
    if (auth !== 'authenticated') return
    const socket = connect()
    let renewals = 0
    let renewing = false
    let closed = false

    async function renew() {
      if (renewing || closed || renewals >= MAX_RENEWALS) return
      renewing = true
      renewals += 1
      try {
        await api.refresh()
        if (!closed) socket.connect()
      } catch {
        // No session to renew: the API client ends it on the next request.
      } finally {
        renewing = false
      }
    }

    socket.on('connect', () => {
      renewals = 0
      setStatus('live')
    })
    socket.on('disconnect', (reason) => {
      setStatus('down')
      // The server closed it on purpose; anything else reconnects by itself.
      if (reason === 'io server disconnect') void renew()
    })
    socket.on('connect_error', (err: Error) => {
      setStatus('down')
      if (RENEWABLE.includes(err.message)) void renew()
    })
    socket.onAny((event: string, payload: unknown) => {
      for (const key of STALE[event] ?? []) void queryClient.invalidateQueries({ queryKey: [...key] })
      handlers.current.get(event)?.forEach((handler) => handler(payload))
    })

    setStatus('connecting')
    socket.connect()
    return () => {
      closed = true
      socket.removeAllListeners()
      socket.disconnect()
      setStatus('off')
    }
  }, [auth, api, queryClient, connect])

  const subscribe = useCallback((event: string, handler: Handler) => {
    const set = handlers.current.get(event) ?? new Set<Handler>()
    set.add(handler)
    handlers.current.set(event, set)
    return () => void set.delete(handler)
  }, [])
  const value = useMemo(() => ({ status, subscribe }), [status, subscribe])

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}
