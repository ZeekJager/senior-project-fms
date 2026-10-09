import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/shared'
import { useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useRetireDriver } from './api'
import type { Driver } from './types'

const MESSAGES: Record<string, string> = {
  CONFLICT_DRIVER_IN_USE: 'This driver is on an active trip or assigned to a vehicle. End the trip or the assignment first, then retire them.',
  NOT_FOUND: 'This driver no longer exists or is outside your depots.',
}

/**
 * Retiring is a soft delete (DELETE /drivers/{id}): the driver leaves the
 * list, keeps their history, and can be reinstated. The licence number is
 * typed to confirm; a refusal shows inside the dialog.
 */
export function RetireDriverDialog({ driver, onClose }: { driver: Driver | null; onClose: () => void }) {
  const retire = useRetireDriver()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setError(null), [driver])

  async function confirm() {
    if (!driver) return
    setError(null)
    try {
      await retire.mutateAsync(driver.id)
      toast({ title: 'Driver retired', description: `${driver.full_name} can be reinstated from the retired list.` })
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? (MESSAGES[err.code] ?? `The driver could not be retired (${err.code}).`) : 'Could not reach the server. Try again.')
    }
  }

  return (
    <ConfirmDialog
      open={driver !== null}
      onClose={onClose}
      title={`Retire ${driver?.full_name ?? ''}`}
      message={
        <p>
          The driver leaves the active list and can no longer be dispatched. Their trips, documents and audit history stay, and they can be
          reinstated later.
        </p>
      }
      action="Retire driver"
      requireTyping={driver?.license_number}
      onConfirm={confirm}
      error={error}
      busy={retire.isPending}
    />
  )
}
