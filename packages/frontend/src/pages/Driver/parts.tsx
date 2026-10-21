import { AlertCircle, ArrowLeft, Truck, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Skeleton, cn } from '@/components/ui'
import { useTripVehicle, type WorkingTrip } from './api'

// Pieces the driver screens share: large type, one idea per block.

/** A centred message in place of the screen's content: nothing today, no signal, done. */
export function Panel({ icon, title, tone, children }: { icon: ReactNode; title: string; tone: 'danger' | 'neutral' | 'success'; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card border border-line bg-surface px-6 py-12 text-center shadow-card">
      <span
        className={cn('mb-4 [&_svg]:h-10 [&_svg]:w-10 [&_svg]:stroke-[1.5]', tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-brand-ink')}
        aria-hidden="true"
      >
        {icon}
      </span>
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="mt-1.5 max-w-xs text-base text-ink-muted">{children}</p>
    </div>
  )
}

/** A refusal or a warning, under the control it is about. */
export function Note({ tone, icon, children }: { tone: 'danger' | 'warning'; icon: ReactNode; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-2.5 rounded-control border px-3.5 py-3 text-base [&>svg]:mt-0.5 [&>svg]:h-5 [&>svg]:w-5 [&>svg]:shrink-0',
        tone === 'danger' ? 'border-danger/25 bg-danger-soft text-danger' : 'border-warning/30 bg-warning-soft text-warning',
      )}
    >
      {icon}
      <span>{children}</span>
    </p>
  )
}

/** A driver form's heading, with the way back to My day. */
export function FormHeader({ title }: { title: string }) {
  return (
    <header>
      <Link to="/driver" className="focus-ring -ml-1 inline-flex items-center gap-1 rounded-control px-1 py-1 text-sm font-medium text-ink-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        My day
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">{title}</h1>
    </header>
  )
}

/**
 * Shows the form only for a trip of the driver's with a vehicle (`useWorkingTrip`):
 * a driver inspects and fuels only the vehicle of their own trip. Otherwise says why.
 */
export function TripGate({
  state,
  tripId,
  noTrip,
  children,
}: {
  state: { trip: WorkingTrip | null; loading: boolean; offline: boolean }
  tripId: string | null
  /** Why there is nothing to do without a trip: "Inspections are for ...". */
  noTrip: { title: string; text: string }
  children: (trip: WorkingTrip & { vehicleId: string }) => ReactNode
}) {
  const { trip, loading, offline } = state
  if (loading) return <Skeleton className="h-96 w-full rounded-card" />
  if (offline) {
    return (
      <Panel icon={<WifiOff />} title="No signal" tone="neutral">
        This trip is not saved on this phone yet. Open it again when you have signal; after that the form works offline.
      </Panel>
    )
  }
  if (!trip) {
    return (
      <Panel icon={<AlertCircle />} title={noTrip.title} tone="neutral">
        {tripId ? 'This trip is not one of yours, or it no longer exists.' : noTrip.text}
      </Panel>
    )
  }
  if (!trip.vehicleId) {
    return (
      <Panel icon={<Truck />} title="No vehicle on this trip yet" tone="neutral">
        Dispatch has not given this trip a vehicle. Call dispatch.
      </Panel>
    )
  }
  return <>{children(trip as WorkingTrip & { vehicleId: string })}</>
}

/** The vehicle the form is about: plate, make and model, route. Its plate when known, for the queue's label. */
export function VehicleCard({ trip }: { trip: WorkingTrip & { vehicleId: string } }) {
  const vehicle = useTripVehicle(trip.vehicleId)
  return (
    <div className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-card">
      <Truck className="h-6 w-6 shrink-0 text-brand-ink" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-lg font-semibold tracking-wide text-ink">{vehicle.data?.registration_number ?? 'Your vehicle'}</span>
        <span className="block truncate text-sm text-ink-muted">
          {[vehicle.data ? `${vehicle.data.make} ${vehicle.data.model}` : null, trip.routeName].filter(Boolean).join(' · ') || 'The vehicle of your trip'}
        </span>
      </span>
    </div>
  )
}
