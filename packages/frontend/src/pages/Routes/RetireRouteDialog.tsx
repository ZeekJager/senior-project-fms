import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/shared'
import { useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useUpdateRoute, type Route } from './api'

const MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this route just now. Close this and open it again.',
  NOT_FOUND: 'This route no longer exists or is outside your depots.',
}

/**
 * Retiring is PATCH { is_active: false }: the route stops being offered for
 * new trips, while trips that used it keep it. It can be restored from the
 * Retired view, so no typing is needed to confirm.
 */
export function RetireRouteDialog({ route, onClose }: { route: Route | null; onClose: () => void }) {
  const update = useUpdateRoute()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setError(null), [route])

  async function confirm() {
    if (!route) return
    setError(null)
    try {
      await update.mutateAsync({ id: route.id, version: route.version, patch: { is_active: false } })
      toast({ title: 'Route retired', description: `${route.name} is no longer offered for new trips.` })
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? (MESSAGES[err.code] ?? `The route could not be retired (${err.code}).`) : 'Could not reach the server. Try again.')
    }
  }

  return (
    <ConfirmDialog
      open={route !== null}
      onClose={onClose}
      title={`Retire ${route?.name ?? ''}`}
      message={<p>The route will no longer be offered when creating trips. Trips that already used it keep it, and you can restore it from the Retired view.</p>}
      action="Retire route"
      onConfirm={confirm}
      error={error}
      busy={update.isPending}
    />
  )
}
