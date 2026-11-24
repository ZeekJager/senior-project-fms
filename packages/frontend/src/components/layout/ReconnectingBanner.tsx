import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'

/**
 * While the server's database is unavailable for a moment (FMS-162: the primary failing over, the API answering 503
 * with Retry-After), every screen says so instead of showing errors that look final. On the driver's phone what they
 * do is kept and sent when it is back (the offline queue, FMS-81, and the GPS buffer, FMS-57); in the office a save
 * fails until then, so it says to try again.
 */
export function ReconnectingBanner({ variant }: { variant: 'driver' | 'staff' }) {
  const { api } = useAuth()
  const [reconnecting, setReconnecting] = useState(() => api.reconnecting())
  useEffect(() => api.onReconnectingChange(setReconnecting), [api])
  if (!reconnecting) return null
  return (
    <div role="status" aria-live="polite" className="border-b border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
      <div className={variant === 'driver' ? 'mx-auto flex w-full max-w-lg items-start gap-2.5' : 'flex items-start gap-2.5 sm:px-2 lg:px-4'}>
        <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-warning motion-reduce:animate-none" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Reconnecting…</p>
          <p className="mt-0.5 text-ink-muted">
            {variant === 'driver'
              ? 'The server is switching over. Your location and anything you submit are kept on this phone and sent when it is back, usually within a minute.'
              : 'The database is switching over, usually for under a minute. Saving does not work until then: try again shortly. Nothing is lost.'}
          </p>
        </div>
      </div>
    </div>
  )
}
