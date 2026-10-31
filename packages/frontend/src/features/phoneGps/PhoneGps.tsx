import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'
import { useTodayTrips } from '@/pages/Driver/api'
import { PhoneGpsBroadcaster, type GpsStatus } from './broadcaster'
import { bufferPing, countPings, oldestPings, removePings, type PhonePing } from './buffer'

interface PhoneGps {
  status: GpsStatus
  /** Ask for the position again, after the driver allowed it in the browser's settings. */
  retry: () => void
}

const OFF: PhoneGps = { status: { state: 'off', waiting: 0, lastSentAt: null, dropped: 0 }, retry: () => {} }
const Context = createContext<PhoneGps>(OFF)

/**
 * Around the driver portal (FMS-57): while the driver's own trip is under way, their phone is the vehicle's GPS,
 * whichever tab is open. The trips are the driver's own (the API's scope), so nothing is ever sent for anyone
 * else's; ending the trip stops the watch at once, and what is still on the phone is sent when it can.
 */
export function PhoneGpsProvider({ children }: { children: ReactNode }) {
  const { session, api } = useAuth()
  const ownerId = session?.user.id ?? ''
  const today = useTodayTrips()
  const underWay = (today.data ?? []).some((t) => t.status === 'en_route')

  const broadcaster = useMemo(
    () =>
      ownerId
        ? new PhoneGpsBroadcaster({
            geolocation: typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
            buffer: {
              add: (ping) => bufferPing(ownerId, ping),
              oldest: (limit) => oldestPings(ownerId, limit),
              count: () => countPings(ownerId),
              remove: removePings,
            },
            send: (pings: PhonePing[]) => api.request('/tracking/gps-pings', { method: 'POST', json: { pings } }),
            online: () => navigator.onLine && !api.servedOffline(),
          })
        : null,
    [ownerId, api],
  )
  const [status, setStatus] = useState<GpsStatus>(OFF.status)

  useEffect(() => {
    if (!broadcaster) return
    const unsubscribe = broadcaster.subscribe(setStatus)
    broadcaster.start()
    return () => {
      unsubscribe()
      broadcaster.stop()
    }
  }, [broadcaster])

  useEffect(() => broadcaster?.track(underWay), [broadcaster, underWay])

  const value = useMemo(() => ({ status, retry: () => broadcaster?.retry() }), [status, broadcaster])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function usePhoneGps(): PhoneGps {
  return useContext(Context)
}
