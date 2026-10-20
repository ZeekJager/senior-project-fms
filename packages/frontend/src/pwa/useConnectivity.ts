import { useEffect, useState } from 'react'
import type { ApiClient } from '@/lib/api/client'

/**
 * Whether the server can be reached (FMS-34): false in airplane mode
 * (`navigator.onLine`), and also when the phone has a network but the
 * server's answers come from the driver app's saved copy.
 */
export function useConnectivity(api: Pick<ApiClient, 'servedOffline' | 'onServedOfflineChange'>): boolean {
  const [networkUp, setNetworkUp] = useState(() => navigator.onLine)
  const [fromCopy, setFromCopy] = useState(() => api.servedOffline())
  useEffect(() => api.onServedOfflineChange(setFromCopy), [api])
  useEffect(() => {
    const up = () => setNetworkUp(true)
    const down = () => setNetworkUp(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return networkUp && !fromCopy
}
