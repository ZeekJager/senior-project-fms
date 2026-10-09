import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/shared'
import { useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useDecommissionVehicle } from './api'
import type { Vehicle } from './types'

const MESSAGES: Record<string, string> = {
  CONFLICT_VEHICLE_IN_USE:
    'This vehicle is on an active trip or assigned to a driver. End the trip or the assignment first, then decommission it.',
  NOT_FOUND: 'This vehicle no longer exists or is outside your depots.',
}

/**
 * Decommissioning is a soft retire (DELETE /vehicles/{id}): the vehicle
 * leaves the list but its history and plate are kept. The user types the
 * plate to confirm; a refusal is shown inside the dialog, not as a toast.
 */
export function DecommissionDialog({ vehicle, onClose }: { vehicle: Vehicle | null; onClose: () => void }) {
  const retire = useDecommissionVehicle()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setError(null), [vehicle])

  async function confirm() {
    if (!vehicle) return
    setError(null)
    try {
      await retire.mutateAsync(vehicle.id)
      toast({ title: 'Vehicle decommissioned', description: `${vehicle.registration_number} is retired. Its history is kept.` })
      onClose()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (MESSAGES[err.code] ?? `The vehicle could not be decommissioned (${err.code}).`)
          : 'Could not reach the server. Try again.',
      )
    }
  }

  return (
    <ConfirmDialog
      open={vehicle !== null}
      onClose={onClose}
      title={`Decommission ${vehicle?.registration_number ?? ''}`}
      message={
        <p>
          The vehicle is retired and leaves the active fleet. Its trips, documents and audit history stay, and the plate cannot be
          reused. This cannot be undone here.
        </p>
      }
      action="Decommission vehicle"
      requireTyping={vehicle?.registration_number}
      onConfirm={confirm}
      error={error}
      busy={retire.isPending}
    />
  )
}
