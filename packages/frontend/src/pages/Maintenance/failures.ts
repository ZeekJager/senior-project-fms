// What failed on a repair (FMS-125): the catalogues in docs/maintenance.md, labelled for the workshop,
// and the check the repair log runs before anything is sent.

export const FAILURE_COMPONENTS = ['engine', 'cooling', 'brakes', 'tyres', 'transmission', 'electrical', 'suspension', 'steering', 'fuel_system', 'exhaust', 'body', 'other'] as const
export const FAILURE_MODES = ['wear', 'leak', 'overheating', 'electrical_fault', 'breakage', 'puncture', 'other'] as const
export const FAILURE_DETECTIONS = ['technician', 'driver_report', 'dvir', 'telematics', 'breakdown'] as const

export type FailureComponent = (typeof FAILURE_COMPONENTS)[number]
export type FailureMode = (typeof FAILURE_MODES)[number]
export type FailureDetection = (typeof FAILURE_DETECTIONS)[number]

export const COMPONENT_LABELS: Record<FailureComponent, string> = {
  engine: 'Engine',
  cooling: 'Cooling',
  brakes: 'Brakes',
  tyres: 'Tyres and wheels',
  transmission: 'Transmission and clutch',
  electrical: 'Electrical',
  suspension: 'Suspension',
  steering: 'Steering',
  fuel_system: 'Fuel system',
  exhaust: 'Exhaust',
  body: 'Body and cab',
  other: 'Other',
}

export const MODE_LABELS: Record<FailureMode, string> = {
  wear: 'Worn out',
  leak: 'Leak',
  overheating: 'Overheating',
  electrical_fault: 'Electrical fault',
  breakage: 'Broken or cracked',
  puncture: 'Puncture',
  other: 'Other',
}

export const DETECTION_LABELS: Record<FailureDetection, string> = {
  technician: 'Found by the technician',
  driver_report: 'Reported by the driver',
  dvir: 'Driver inspection (DVIR)',
  telematics: 'Telematics alert',
  breakdown: 'Breakdown on the road',
}

/** A failure as the API takes it. */
export interface FailureInput {
  component: FailureComponent
  failure_mode: FailureMode
  unplanned: boolean
  detected_by: FailureDetection
}

/** A failure as the API returns it. */
export interface FailureEvent extends FailureInput {
  id: string
  vehicle_id: string
  registration_number: string
  maintenance_record_id: string | null
  incident_id: string | null
  occurred_at: string
  odometer_km: number | null
  notes: string | null
  recorded_by: string | null
  created_at: string
}

/** One failure being filled in on the form. */
export interface FailureDraft {
  key: number
  component: FailureComponent | ''
  failure_mode: FailureMode | ''
  unplanned: boolean | null
  detected_by: FailureDetection
}

let nextKey = 1

export function emptyFailure(): FailureDraft {
  return { key: nextKey++, component: '', failure_mode: '', unplanned: null, detected_by: 'technician' }
}

const isBlank = (d: FailureDraft) => d.component === '' && d.failure_mode === '' && d.unplanned === null

/**
 * The failures to send, or the errors to show (keyed `failure.<i>.<field>`, and `failures` for the
 * section). A row left untouched is ignored; one started must be finished. `required`: completing a
 * repair, which needs at least one.
 */
export function checkFailures(drafts: readonly FailureDraft[], required: boolean): { failures: FailureInput[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const failures: FailureInput[] = []
  drafts.forEach((d, i) => {
    if (isBlank(d)) return
    if (d.component === '') errors[`failure.${i}.component`] = 'Choose the part of the vehicle that failed.'
    if (d.failure_mode === '') errors[`failure.${i}.failure_mode`] = 'Choose how it failed.'
    if (d.unplanned === null) errors[`failure.${i}.unplanned`] = 'Say whether it was a breakdown or found at planned work.'
    if (d.component !== '' && d.failure_mode !== '' && d.unplanned !== null) {
      failures.push({ component: d.component, failure_mode: d.failure_mode, unplanned: d.unplanned, detected_by: d.detected_by })
    }
  })
  if (required && failures.length === 0 && Object.keys(errors).length === 0) errors.failures = 'Say what failed: a repair can be completed only with at least one failure.'
  return { failures, errors }
}
