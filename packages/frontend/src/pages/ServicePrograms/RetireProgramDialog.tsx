import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/shared'
import { useToast } from '@/components/ui'
import { useUpdateProgram, type ServiceProgram } from '@/features/service-due'
import { ApiError } from '@/lib/api/errors'

const MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this program just now. Close this and open it again.',
  NOT_FOUND: 'This program no longer exists or is outside your depots.',
}

/**
 * Retiring is PATCH { is_active: false }: its vehicles are no longer due under it, and the repairs that
 * carried it out keep it. It can be restored from the Retired view, so no typing is needed to confirm.
 */
export function RetireProgramDialog({ program, onClose }: { program: ServiceProgram | null; onClose: () => void }) {
  const update = useUpdateProgram()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setError(null), [program])

  async function confirm() {
    if (!program) return
    setError(null)
    try {
      await update.mutateAsync({ id: program.id, version: program.version, patch: { is_active: false } })
      toast({ title: 'Program retired', description: `${program.name} no longer schedules service.` })
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? (MESSAGES[err.code] ?? `The program could not be retired (${err.code}).`) : 'Could not reach the server. Try again.')
    }
  }

  const covered = program?.vehicles.total ?? 0
  return (
    <ConfirmDialog
      open={program !== null}
      onClose={onClose}
      title={`Retire ${program?.name ?? ''}`}
      message={
        <p>
          {covered > 0 ? `Its ${covered.toLocaleString('en-US')} vehicle${covered === 1 ? ' is' : 's are'} no longer due under it, and it raises no more due or overdue alerts. ` : ''}
          Repairs that carried it out keep it, and you can restore it from the Retired view.
        </p>
      }
      action="Retire program"
      onConfirm={confirm}
      error={error}
      busy={update.isPending}
    />
  )
}
