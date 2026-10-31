import { MapPinOff, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui'
import { usePhoneGps } from './PhoneGps'

/**
 * Under the driver portal's top bar, on every tab, while a trip is under way and the phone cannot share its
 * position: the driver blocked location, or the phone has none. Dispatch then sees the vehicle stand still.
 */
export function LocationBanner() {
  const { status, retry } = usePhoneGps()
  if (status.state !== 'denied' && status.state !== 'unavailable') return null
  const denied = status.state === 'denied'
  return (
    <div aria-live="polite" className="border-b border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">
      <div className="mx-auto flex w-full max-w-lg items-start gap-2.5">
        <MapPinOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{denied ? 'Location is blocked' : 'This phone cannot find its location'}</p>
          <p className="mt-0.5 text-danger/90">
            {denied
              ? 'Dispatch cannot see your vehicle on the map. Allow location for this app in your phone’s browser settings, then press Try again.'
              : 'Dispatch cannot see your vehicle on the map. Turn on location in your phone’s settings, then press Try again.'}
          </p>
        </div>
        <Button size="sm" variant="secondary" leadingIcon={<RotateCcw className="h-3.5 w-3.5" />} onClick={retry} className="shrink-0">
          Try again
        </Button>
      </div>
    </div>
  )
}
