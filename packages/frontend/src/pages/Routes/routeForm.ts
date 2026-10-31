import type { Coordinates, Route, RouteInput, RouteStop } from './api'

/** A stop row as typed. `key` keeps React rows stable while stops move. */
export interface StopValues {
  key: string
  name: string
  coordinates: string
}

/** The form's fields as typed: always text, so nothing is rounded or lost while editing. */
export interface RouteFormValues {
  name: string
  depot_id: string
  origin_name: string
  /** "latitude, longitude", as a map app copies it. */
  origin: string
  destination_name: string
  destination: string
  stops: StopValues[]
  distance_km: string
  hours: string
  minutes: string
}

export type FieldName = Exclude<keyof RouteFormValues, 'stops'> | `stops.${number}.name` | `stops.${number}.coordinates` | 'stops'
export type FieldErrors = Partial<Record<FieldName, string>>

export const MAX_STOPS = 25

let nextKey = 0
export const newStop = (stop?: RouteStop): StopValues => ({
  key: `stop-${++nextKey}`,
  name: stop?.name ?? '',
  coordinates: stop && stop.latitude !== null && stop.longitude !== null ? formatCoordinates(stop as Coordinates) : '',
})

export const EMPTY_FORM: RouteFormValues = {
  name: '',
  depot_id: '',
  origin_name: '',
  origin: '',
  destination_name: '',
  destination: '',
  stops: [],
  distance_km: '',
  hours: '',
  minutes: '',
}

export function formatCoordinates(c: Coordinates): string {
  return `${c.latitude}, ${c.longitude}`
}

export function formFromRoute(r: Route): RouteFormValues {
  const seconds = r.estimated_duration_seconds
  return {
    name: r.name,
    depot_id: r.depot_id,
    origin_name: r.origin_name ?? '',
    origin: r.origin ? formatCoordinates(r.origin) : '',
    destination_name: r.destination_name ?? '',
    destination: r.destination ? formatCoordinates(r.destination) : '',
    stops: r.stops.map(newStop),
    distance_km: r.distance_km === null ? '' : String(r.distance_km),
    hours: seconds === null ? '' : String(Math.floor(seconds / 3600)),
    minutes: seconds === null ? '' : String(Math.round((seconds % 3600) / 60)),
  }
}

const NUMBER = /^-?\d{1,3}(\.\d+)?$/
const DISTANCE = /^\d{1,6}(\.\d{1,3})?$/

/** "9.0054, 38.7636" (a comma, spaces or both between) to a point; null if blank; a message if wrong. */
export function parseCoordinates(text: string): { ok: true; value: Coordinates | null } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: null }
  const parts = trimmed.split(/\s*,\s*|\s+/)
  if (parts.length !== 2 || !parts.every((p) => NUMBER.test(p))) return { ok: false, error: 'Latitude, then longitude, e.g. 9.0054, 38.7636.' }
  const [latitude, longitude] = parts.map(Number)
  if (latitude < -90 || latitude > 90) return { ok: false, error: 'Latitude is between -90 and 90.' }
  if (longitude < -180 || longitude > 180) return { ok: false, error: 'Longitude is between -180 and 180.' }
  if (parts.some((p) => (p.split('.')[1] ?? '').length > 6)) return { ok: false, error: 'At most 6 decimals (about 10 cm).' }
  return { ok: true, value: { latitude, longitude } }
}

/**
 * Checks the form the way the API will (api-contract §7.1) and builds the
 * request body. The API stays the authority; this saves a round trip and
 * puts each message next to its field. Blank stop rows are dropped.
 */
export function validateRouteForm(values: RouteFormValues): { errors: FieldErrors; input: RouteInput | null } {
  const errors: FieldErrors = {}
  const name = values.name.trim()
  if (!name) errors.name = 'Give the route a name.'
  else if (name.length > 255) errors.name = 'At most 255 characters.'
  if (!values.depot_id) errors.depot_id = 'Choose the depot this route belongs to.'

  for (const field of ['origin_name', 'destination_name'] as const) {
    if (values[field].trim().length > 255) errors[field] = 'At most 255 characters.'
  }
  const origin = parseCoordinates(values.origin)
  if (!origin.ok) errors.origin = origin.error
  const destination = parseCoordinates(values.destination)
  if (!destination.ok) errors.destination = destination.error

  const stops: RouteStop[] = []
  values.stops.forEach((s, i) => {
    if (!s.name.trim() && !s.coordinates.trim()) return
    if (!s.name.trim()) errors[`stops.${i}.name`] = 'Name the stop.'
    else if (s.name.trim().length > 255) errors[`stops.${i}.name`] = 'At most 255 characters.'
    const point = parseCoordinates(s.coordinates)
    if (!point.ok) errors[`stops.${i}.coordinates`] = point.error
    stops.push({ name: s.name.trim(), latitude: point.ok ? (point.value?.latitude ?? null) : null, longitude: point.ok ? (point.value?.longitude ?? null) : null })
  })
  if (stops.length > MAX_STOPS) errors.stops = `At most ${MAX_STOPS} stops.`

  const distanceText = values.distance_km.trim()
  let distance: number | null = null
  if (distanceText) {
    if (!DISTANCE.test(distanceText)) errors.distance_km = 'Kilometres, with at most 3 decimals.'
    else if (Number(distanceText) > 100_000) errors.distance_km = 'At most 100,000 km.'
    else distance = Number(distanceText)
  }

  const hoursText = values.hours.trim()
  const minutesText = values.minutes.trim()
  let duration: number | null = null
  if (hoursText || minutesText) {
    const hours = hoursText ? Number(hoursText) : 0
    const minutes = minutesText ? Number(minutesText) : 0
    if (!/^\d{1,3}$/.test(hoursText || '0') || hours > 720) errors.hours = 'Whole hours, up to 720.'
    if (!/^\d{1,2}$/.test(minutesText || '0') || minutes > 59) errors.minutes = 'Whole minutes, 0 to 59.'
    if (!errors.hours && !errors.minutes) duration = hours * 3600 + minutes * 60
  }

  if (Object.keys(errors).length > 0) return { errors, input: null }
  return {
    errors,
    input: {
      name,
      depot_id: values.depot_id,
      origin_name: values.origin_name.trim() || null,
      origin: origin.ok ? origin.value : null,
      destination_name: values.destination_name.trim() || null,
      destination: destination.ok ? destination.value : null,
      stops,
      distance_km: distance,
      estimated_duration_seconds: duration,
    },
  }
}

/** For PATCH: only what changed against the route as loaded. */
export function changedFields(input: RouteInput, original: Route): Partial<RouteInput> {
  // Key order fixed on both sides, so only values are compared.
  const stops = (list: RouteStop[]) => list.map((s) => ({ name: s.name, latitude: s.latitude, longitude: s.longitude }))
  const point = (c: Coordinates | null) => (c ? { latitude: c.latitude, longitude: c.longitude } : null)
  // The form shows the time in whole minutes (a road's is to the second): unchanged when the minutes are.
  const shown = (s: number | null) => (s === null ? null : Math.floor(s / 3600) * 3600 + Math.round((s % 3600) / 60) * 60)
  const before: Record<keyof RouteInput, unknown> = {
    ...original,
    origin: point(original.origin),
    destination: point(original.destination),
    stops: stops(original.stops),
    estimated_duration_seconds: shown(original.estimated_duration_seconds),
  }
  const after: Record<keyof RouteInput, unknown> = { ...input, origin: point(input.origin), destination: point(input.destination), stops: stops(input.stops) }
  const patch: Partial<RouteInput> = {}
  for (const key of Object.keys(input) as (keyof RouteInput)[]) {
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) (patch as Record<string, unknown>)[key] = input[key]
  }
  return patch
}

/** API error fields (`origin.latitude`, `stops.2`) to form fields. */
export function formField(apiField: string | undefined): FieldName | undefined {
  if (!apiField) return undefined
  const [head, index] = apiField.split('.')
  if (head === 'origin' || head === 'destination') return head
  if (head === 'stops') return index !== undefined && /^\d+$/.test(index) ? `stops.${Number(index)}.coordinates` : 'stops'
  if (head === 'estimated_duration_seconds') return 'hours'
  const direct: string[] = ['name', 'depot_id', 'origin_name', 'destination_name', 'distance_km']
  return direct.includes(head) ? (head as FieldName) : undefined
}

/** "2 h 30 min", "45 min", or an em dash for unknown. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (hours === 0) return `${minutes} min`
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

export function formatDistance(km: number | null): string {
  return km === null ? '—' : `${km.toLocaleString('en-GB', { maximumFractionDigits: 1 })} km`
}
