// An incident as the driver reports it (FMS-38, S-13), and as POST /incidents
// takes it (api-contract §12.2).

export const INCIDENT_TYPES = [
  { value: 'accident', label: 'Accident' },
  { value: 'breakdown', label: 'Breakdown' },
  { value: 'tyre', label: 'Tyre' },
  { value: 'theft', label: 'Theft' },
  { value: 'vandalism', label: 'Vandalism' },
  { value: 'injury', label: 'Injury' },
  { value: 'road_hazard', label: 'Road hazard' },
  { value: 'other', label: 'Other' },
] as const

export type IncidentType = (typeof INCIDENT_TYPES)[number]['value']

/** The API's severities, in the driver's words. Critical takes the vehicle off the road. */
export const SEVERITIES = [
  { value: 'low', label: 'Minor', text: 'No damage and no danger. For the record.' },
  { value: 'medium', label: 'Moderate', text: 'Some damage. I can carry on.' },
  { value: 'high', label: 'Serious', text: 'Damage or danger. I need help.' },
  { value: 'critical', label: 'Critical', text: 'The vehicle must not be driven, or someone is hurt.' },
] as const

export type Severity = (typeof SEVERITIES)[number]['value']

/** POST /incidents takes at most this much text. */
export const MAX_DESCRIPTION = 2000

export interface Position {
  latitude: number
  longitude: number
  /** Metres, as the phone reports it. Shown, never sent. */
  accuracy: number
}

export interface IncidentDraft {
  /** None chosen is sent as `other`. */
  type: IncidentType | null
  severity: Severity | null
  description: string
  location: Position | null
}

export const EMPTY_INCIDENT: IncidentDraft = { type: null, severity: null, description: '', location: null }

export type IncidentErrors = Partial<Record<'severity' | 'description', string>>

export function checkIncident(d: IncidentDraft): IncidentErrors {
  const errors: IncidentErrors = {}
  if (d.severity === null) errors.severity = 'Choose how serious it is.'
  const text = d.description.trim()
  if (text === '') errors.description = 'Say what happened.'
  else if (text.length > MAX_DESCRIPTION) errors.description = `Use at most ${MAX_DESCRIPTION.toLocaleString('en')} characters.`
  return errors
}

/** NUMERIC(9,6): six decimals is about 10 cm, more than any phone knows. */
const coordinate = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * The body, once `checkIncident` found nothing. `occurred_at` is the moment
 * the driver pressed send: the report keeps it however late the queue
 * delivers it, and the server recognises a late replay by it.
 */
export function incidentBody(d: IncidentDraft, about: { tripId: string; vehicleId: string } | null, now: Date) {
  return {
    description: d.description.trim(),
    severity: d.severity!,
    incident_type: d.type ?? 'other',
    ...(about ? { vehicle_id: about.vehicleId, trip_id: about.tripId } : {}),
    ...(d.location ? { latitude: coordinate(d.location.latitude), longitude: coordinate(d.location.longitude) } : {}),
    occurred_at: now.toISOString(),
  }
}

export const severityLabel = (value: Severity) => SEVERITIES.find((s) => s.value === value)!.label
