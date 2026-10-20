import { createContext, useContext, useEffect, useRef } from 'react'

// What screens use of the live updates (FMS-43), without the socket library:
// RealtimeProvider (mounted once, in App) holds the socket.

export type RealtimeStatus = 'off' | 'connecting' | 'live' | 'down'

export type RealtimeHandler = (payload: unknown) => void

export interface RealtimeValue {
  status: RealtimeStatus
  subscribe(event: string, handler: RealtimeHandler): () => void
}

export const RealtimeContext = createContext<RealtimeValue | null>(null)

/** Whether live updates are flowing. `off` outside the provider (tests, signed out). */
export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeContext)?.status ?? 'off'
}

/** Calls `handler` for each `event` from the server while mounted. Does nothing outside the provider. */
export function useRealtimeEvent(event: string, handler: RealtimeHandler): void {
  const subscribe = useContext(RealtimeContext)?.subscribe
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(() => subscribe?.(event, (payload) => latest.current(payload)), [subscribe, event])
}
