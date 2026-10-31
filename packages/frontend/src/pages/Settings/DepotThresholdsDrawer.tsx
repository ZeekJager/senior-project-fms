import { AlertCircle, Undo2 } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Button, Drawer, SelectField, useToast } from '@/components/ui'
import type { Depot } from '@/features/depots'
import { ApiError } from '@/lib/api/errors'
import { useRemoveDepotThresholds, useSaveThresholds, type Thresholds } from './api'
import { ThresholdFields, toValues, validateThresholds, type ThresholdErrors, type ThresholdValues } from './ThresholdFields'

interface DepotThresholdsDrawerProps {
  open: boolean
  onClose: () => void
  /** The depot whose own thresholds are edited; null: choose a depot to give some. */
  depotId: string | null
  /** Its own thresholds, or (adding) the fleet's to start from. */
  start: Thresholds
  /** Depots that can be chosen when adding: those without their own yet. */
  choices: Depot[]
  depotName: (id: string) => string
}

/**
 * A depot's own speeding and idling thresholds, which replace the fleet's for its vehicles (FMS-46). Removing
 * them puts the depot back on the fleet's.
 */
export function DepotThresholdsDrawer({ open, onClose, depotId, start, choices, depotName }: DepotThresholdsDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const save = useSaveThresholds()
  const remove = useRemoveDepotThresholds()
  const [chosen, setChosen] = useState('')
  const [values, setValues] = useState<ThresholdValues>(toValues(start))
  const [errors, setErrors] = useState<ThresholdErrors>({})
  const [depotError, setDepotError] = useState<string | undefined>()
  const [formError, setFormError] = useState<string | null>(null)
  const busy = save.isPending || remove.isPending

  useEffect(() => {
    if (!open) return
    setChosen('')
    setValues(toValues(start))
    setErrors({})
    setDepotError(undefined)
    setFormError(null)
    // Only on opening: a refetch behind the panel never overwrites what is being typed.
  }, [open, depotId])

  const target = depotId ?? chosen

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setFormError(null)
    const { errors: found, thresholds } = validateThresholds(values)
    setErrors(found)
    setDepotError(target ? undefined : 'Choose a depot.')
    if (!thresholds || !target) return
    try {
      await save.mutateAsync({ depotId: target, thresholds })
      toast({ title: 'Thresholds saved', description: `${depotName(target)}'s vehicles follow them within a minute.` })
      onClose()
    } catch (err) {
      setFormError(message(err))
    }
  }

  async function onRemove() {
    if (!depotId || busy) return
    try {
      await remove.mutateAsync(depotId)
      toast({ title: 'Back on the fleet’s thresholds', description: `${depotName(depotId)} follows the fleet’s speeding and idling thresholds again.` })
      onClose()
    } catch (err) {
      setFormError(message(err))
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={depotId ? `${depotName(depotId)} thresholds` : 'Thresholds for a depot'}
      description="Replace the fleet’s speeding and idling thresholds for one depot’s vehicles, e.g. a lower limit in town."
      footer={
        <>
          {depotId && (
            <Button variant="ghost" leadingIcon={<Undo2 className="h-4 w-4" />} className="mr-auto" onClick={() => void onRemove()} disabled={busy}>
              Use the fleet’s
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            Save thresholds
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-6">
        <div role="alert" className="empty:-mb-6">
          {formError && (
            <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
        </div>
        {!depotId && (
          <SelectField
            label="Depot"
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value)
              setDepotError(undefined)
            }}
            error={depotError}
            placeholder="Choose a depot…"
            options={choices.map((d) => ({ value: d.id, label: d.name }))}
            hint={choices.length === 0 ? 'Every depot already has its own.' : 'Starts from the fleet’s thresholds.'}
          />
        )}
        <ThresholdFields values={values} errors={errors} onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))} />
      </form>
    </Drawer>
  )
}

function message(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Could not reach the server. Check your connection and try again.'
  if (err.code === 'NOT_FOUND') return 'This depot no longer exists, or has no thresholds of its own.'
  return `The thresholds could not be saved (${err.code}).`
}
