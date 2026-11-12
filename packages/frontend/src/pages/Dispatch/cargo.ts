import type { CargoKind, JobLoad, JobLoadReason, Trip } from './types'

// The load of a job on each trip (FMS-153, docs/job-load.md): the labels the console shows, and the cargo weight as
// the dispatcher types it.

export const CARGO_KINDS: readonly { value: CargoKind; label: string }[] = [
  { value: 'general', label: 'General goods' },
  { value: 'fragile', label: 'Fragile' },
  { value: 'hazardous', label: 'Hazardous' },
  { value: 'refrigerated', label: 'Refrigerated' },
  { value: 'passengers', label: 'Passengers' },
]

export const cargoKindLabel = (kind: CargoKind) => CARGO_KINDS.find((k) => k.value === kind)?.label ?? kind

export const JOB_LOAD_LABELS: Record<JobLoad, string> = { light: 'Light job', standard: 'Standard job', heavy: 'Heavy job' }

/** Why a job loads as it does, as the dispatcher reads it. The thresholds are the backend's (docs/job-load.md). */
export const JOB_LOAD_REASONS: Record<JobLoadReason, string> = {
  long_haul: 'Long haul, 300 km or more',
  regional: 'Over 100 km',
  long_day: 'A long day, 9 h or more',
  long_hours: '4 h or more at the wheel',
  many_stops: '6 stops or more',
  night: 'Night driving',
  near_payload: 'Near the vehicle’s payload',
  loaded: 'Over 60% of the payload',
}

export const jobLoadReason = (reason: JobLoadReason) => JOB_LOAD_REASONS[reason] ?? reason.replaceAll('_', ' ')

const kg = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 })
export const formatKg = (value: number) => `${kg.format(value)} kg`

/** What the trip carries, in a few words. */
export function cargoSummary(trip: Pick<Trip, 'cargo_kind' | 'cargo_weight_kg'>): string {
  const kind = trip.cargo_kind ?? 'general'
  const weight = trip.cargo_weight_kg ?? null
  if (weight === null) return kind === 'general' ? 'No cargo recorded' : `${cargoKindLabel(kind)}, weight not recorded`
  return `${formatKg(weight)} · ${cargoKindLabel(kind)}`
}

/** The heaviest cargo a trip records (the API's limit). */
export const MAX_CARGO_KG = 100_000

/** A weight as typed: blank is none; otherwise a positive number of kg, two decimals at most. */
export function parseCargoWeight(text: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = text.trim().replaceAll(',', '')
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { ok: false, error: 'A weight in kg, e.g. 1200 or 1200.5.' }
  const value = Number(trimmed)
  if (value <= 0) return { ok: false, error: 'More than 0 kg, or leave it blank.' }
  if (value > MAX_CARGO_KG) return { ok: false, error: `At most ${kg.format(MAX_CARGO_KG)} kg.` }
  return { ok: true, value }
}
