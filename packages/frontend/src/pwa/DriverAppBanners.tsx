import { Download, WifiOff, X } from 'lucide-react'
import { useState } from 'react'
import { Button, IconButton } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDriverPwa } from './useDriverPwa'

const DISMISSED_KEY = 'fms-driver-install-dismissed'

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Under the driver portal's top bar: "you are offline" while the phone has
 * no signal, and an offer to install the app when Chrome makes one (FMS-34).
 */
export function DriverAppBanners() {
  const { session, api } = useAuth()
  const { online, installable, install } = useDriverPwa(session, api)
  const [dismissed, setDismissed] = useState(wasDismissed)

  function notNow() {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // Private mode: it comes back next time, which is fine.
    }
  }

  return (
    <>
      {!online && (
        <div role="status" className="flex items-center gap-2.5 border-b border-warning/30 bg-warning-soft px-4 py-2.5 text-sm text-warning">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-semibold">You are offline.</span> My day opens from this phone; anything you send waits for a connection.
          </p>
        </div>
      )}
      {installable && !dismissed && (
        <div className="mx-auto mt-4 flex w-full max-w-lg items-center gap-3 px-4">
          <div className="flex w-full items-center gap-3 rounded-card border border-line bg-surface p-3 shadow-card">
            <img src="/icons/icon-192.png" alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-[10px]" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">Install FMS Driver</p>
              <p className="text-xs text-ink-muted">Opens like an app and works where there is no signal.</p>
            </div>
            <Button size="sm" leadingIcon={<Download className="h-3.5 w-3.5" />} onClick={() => void install()}>
              Install
            </Button>
            <IconButton size="sm" label="Not now" icon={<X className="h-4 w-4" />} onClick={notNow} />
          </div>
        </div>
      )}
    </>
  )
}
