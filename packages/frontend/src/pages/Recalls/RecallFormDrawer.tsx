import { AlertCircle } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Button, Drawer, TextAreaField, TextField, useToast } from '@/components/ui'
import { recallTarget, useCreateRecall, useUpdateRecall, type Recall } from '@/features/warranty'
import { ApiError } from '@/lib/api/errors'
import { EMPTY_RECALL, changedRecall, changesTarget, checkRecall, formFromRecall, type RecallErrors, type RecallField, type RecallFormValues } from './recallForm'

const MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this recall while you were editing. Close the panel to see their changes, then edit again.',
  FORBIDDEN_INSUFFICIENT_ROLE: 'A recall applies to the whole fleet: only someone who sees every depot can issue or change one.',
  NOT_FOUND: 'This recall no longer exists.',
}

const vehiclesText = (n: number) => (n === 0 ? 'No vehicle in service matches it yet.' : `${n} vehicle${n === 1 ? '' : 's'} listed as open.`)

/**
 * Issue a manufacturer recall, or correct one (FMS-133): the campaign, the make, model and model years it
 * applies to, and the remedy. Every vehicle in service it matches is listed as open on saving.
 */
export function RecallFormDrawer({ open, onClose, recall }: { open: boolean; onClose: () => void; recall: Recall | null }) {
  const formId = useId()
  const { toast } = useToast()
  const create = useCreateRecall()
  const update = useUpdateRecall()
  const saving = create.isPending || update.isPending
  const [values, setValues] = useState<RecallFormValues>(EMPTY_RECALL)
  const [errors, setErrors] = useState<RecallErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setValues(recall ? formFromRecall(recall) : EMPTY_RECALL)
    setErrors({})
    setFormError(null)
  }, [open, recall])

  function set(field: RecallField, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    setErrors((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setFormError(null)
    const { errors: found, input } = checkRecall(values)
    setErrors(found)
    if (!input) return
    try {
      if (recall) {
        const patch = changedRecall(input, recall)
        const saved = Object.keys(patch).length > 0 ? await update.mutateAsync({ id: recall.id, version: recall.version, patch }) : recall
        toast({
          title: 'Recall saved',
          description: changesTarget(patch) ? `${recallTarget(saved)}: ${vehiclesText(saved.vehicles.open)}` : saved.campaign_code,
        })
      } else {
        const saved = await create.mutateAsync(input)
        toast({ title: 'Recall issued', description: `${saved.campaign_code}: ${vehiclesText(saved.vehicles.open)}` })
      }
      onClose()
    } catch (err) {
      if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
      if (err.code === 'CONFLICT_DUPLICATE') return setErrors({ campaign_code: 'A recall with this campaign code is already on record.' })
      if (err.code === 'VALIDATION_INVALID_DATE_RANGE') return setErrors({ year_to: 'The same as the first year or later.' })
      setFormError(MESSAGES[err.code] ?? (err.code === 'VALIDATION_FAILED' ? 'Check the values and try again.' : `The recall could not be saved (${err.code}).`))
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={recall ? `Edit ${recall.campaign_code}` : 'Issue recall'}
      description={
        recall
          ? 'Changing the make, model or years matches the fleet again: vehicles it no longer applies to leave the list unless work is booked or done.'
          : 'Every vehicle in service of this make and model with a model year in the range is listed as open, and its depot is alerted.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {recall ? 'Save changes' : 'Issue recall'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5">
        <div role="alert" className="empty:-mb-5">
          {formError && (
            <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
        </div>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <TextField label="Campaign code" value={values.campaign_code} onChange={(e) => set('campaign_code', e.target.value)} error={errors.campaign_code} autoComplete="off" maxLength={50} />
          <TextField label="Issued" optional type="date" value={values.issued_on} onChange={(e) => set('issued_on', e.target.value)} hint="When the manufacturer announced it." />
        </div>
        <fieldset className="space-y-1">
          <legend className="mb-2 text-sm font-medium text-ink">Applies to</legend>
          <p className="mb-3 text-xs text-ink-subtle">Make and model as on the vehicle records, ignoring case. A vehicle with no model year recorded is not matched.</p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField label="Make" value={values.make} onChange={(e) => set('make', e.target.value)} error={errors.make} autoComplete="off" maxLength={100} />
            <TextField label="Model" value={values.model} onChange={(e) => set('model', e.target.value)} error={errors.model} autoComplete="off" maxLength={100} />
            <TextField label="First model year" inputMode="numeric" value={values.year_from} onChange={(e) => set('year_from', e.target.value)} error={errors.year_from} maxLength={4} />
            <TextField label="Last model year" optional inputMode="numeric" value={values.year_to} onChange={(e) => set('year_to', e.target.value)} error={errors.year_to} maxLength={4} hint="Blank: the first year only." />
          </div>
        </fieldset>
        <TextAreaField label="Defect" rows={3} value={values.description} onChange={(e) => set('description', e.target.value)} error={errors.description} maxLength={5000} />
        <TextAreaField label="Remedy" optional rows={2} value={values.remedy} onChange={(e) => set('remedy', e.target.value)} maxLength={5000} hint="What the workshop or dealer does to fix it." />
      </form>
    </Drawer>
  )
}
