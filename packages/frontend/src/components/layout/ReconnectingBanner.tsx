import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import type { ReconnectingCause } from '@/lib/api/client'

/**
 * While the server is unavailable for a moment, every screen says so instead of showing errors that look final: its
 * database failing over (FMS-162: the API answers 503 with Retry-After), or the API itself not answering (FMS-111: a
 * restart, or the way to it cut). On the driver's phone what they do is kept and sent when it is back (the offline
 * queue, FMS-81, and the GPS buffer, FMS-57); in the office a save fails until then, so it says to try again.
 */
const MESSAGES: Record<ReconnectingCause, Record<'driver' | 'staff', string>> = {
  database: {
    driver: 'The server is switching over. Your location and anything you submit are kept on this phone and sent when it is back, usually within a minute.',
    staff: 'The database is switching over, usually for under a minute. Saving does not work until then: try again shortly. Nothing is lost.',
  },
  server: {
    driver: 'The server is not answering. Your location and anything you submit are kept on this phone and sent when it is back.',
    staff: 'The server is not answering: it may be restarting, or this connection may be down. Saving does not work until it answers again: try again shortly.',
  },
}

export function ReconnectingBanner({ variant }: { variant: 'driver' | 'staff' }) {
  const { api } = useAuth()
  const [cause, setCause] = useState<ReconnectingCause | null>(() => api.reconnectingCause())
  useEffect(() => api.onReconnectingChange(() => setCause(api.reconnectingCause())), [api])
  if (!cause) return null
  return (
    <div role="status" aria-live="polite" className="border-b border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
      <div className={variant === 'driver' ? 'mx-auto flex w-full max-w-lg items-start gap-2.5' : 'flex items-start gap-2.5 sm:px-2 lg:px-4'}>
        <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-warning motion-reduce:animate-none" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Reconnecting…</p>
          <p className="mt-0.5 text-ink-muted">{MESSAGES[cause][variant]}</p>
        </div>
      </div>
    </div>
  )
}
