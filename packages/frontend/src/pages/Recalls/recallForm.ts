import type { Recall, RecallInput } from '@/features/warranty'

export interface RecallFormValues {
  campaign_code: string
  make: string
  model: string
  year_from: string
  year_to: string
  description: string
  remedy: string
  issued_on: string
}

export type RecallField = keyof RecallFormValues
export type RecallErrors = Partial<Record<RecallField, string>>

export const EMPTY_RECALL: RecallFormValues = { campaign_code: '', make: '', model: '', year_from: '', year_to: '', description: '', remedy: '', issued_on: '' }

const YEAR = /^\d{4}$/

export function formFromRecall(r: Recall): RecallFormValues {
  return {
    campaign_code: r.campaign_code,
    make: r.make,
    model: r.model,
    year_from: String(r.year_from),
    year_to: String(r.year_to),
    description: r.description,
    remedy: r.remedy ?? '',
    issued_on: r.issued_on ?? '',
  }
}

/** The form's checks, as the API makes them (api-contract §10.5); the input to send when they pass. */
export function checkRecall(v: RecallFormValues): { errors: RecallErrors; input: RecallInput | null } {
  const errors: RecallErrors = {}
  if (!v.campaign_code.trim()) errors.campaign_code = "The manufacturer's campaign number, e.g. 24V-123."
  if (!v.make.trim()) errors.make = 'The make it applies to, e.g. Toyota.'
  if (!v.model.trim()) errors.model = 'The model it applies to, e.g. Hilux.'
  const from = v.year_from.trim()
  const to = v.year_to.trim() || from
  const year = (s: string) => YEAR.test(s) && Number(s) >= 1900 && Number(s) <= 2100
  if (!year(from)) errors.year_from = 'A model year, e.g. 2018.'
  if (v.year_to.trim() && !year(to)) errors.year_to = 'A model year, e.g. 2021.'
  else if (year(from) && year(to) && Number(to) < Number(from)) errors.year_to = 'The same as the first year or later.'
  if (!v.description.trim()) errors.description = 'What is wrong, as the manufacturer describes it.'
  if (Object.keys(errors).length > 0) return { errors, input: null }
  return {
    errors,
    input: {
      campaign_code: v.campaign_code.trim(),
      make: v.make.trim(),
      model: v.model.trim(),
      year_from: Number(from),
      year_to: Number(to),
      description: v.description.trim(),
      remedy: v.remedy.trim() || null,
      issued_on: v.issued_on || null,
    },
  }
}

/** What an edit changed, to send as the PATCH. */
export function changedRecall(input: RecallInput, r: Recall): Partial<RecallInput> {
  const patch: Partial<RecallInput> = {}
  for (const key of Object.keys(input) as (keyof RecallInput)[]) {
    if (input[key] !== r[key]) (patch as Record<string, unknown>)[key] = input[key]
  }
  return patch
}

/** Whether the edit changes which vehicles it applies to. */
export const changesTarget = (patch: Partial<RecallInput>) => ['make', 'model', 'year_from', 'year_to'].some((k) => k in patch)
