import type { OwnedDocument } from './types'

/** Expiring "soon" means within this many days (FMS-18: amber badge). */
export const EXPIRY_WARNING_DAYS = 30

export type ExpiryState = 'expired' | 'expiring' | 'valid' | 'none'

/** Today as YYYY-MM-DD in the user's time zone, the calendar the expiry dates are written in. */
export function today(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Whole days from `from` to `to`, both YYYY-MM-DD (UTC arithmetic, so no daylight-saving drift). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * Expired once the expiry date has passed (a document is still valid on the
 * day it expires); expiring when that day is at most 30 days away.
 */
export function expiryState(expiresOn: string | null, on: string = today()): { state: ExpiryState; days: number | null } {
  if (!expiresOn) return { state: 'none', days: null }
  const days = daysBetween(on, expiresOn)
  if (days < 0) return { state: 'expired', days }
  if (days <= EXPIRY_WARNING_DAYS) return { state: 'expiring', days }
  return { state: 'valid', days }
}

export interface DocumentHealth {
  total: number
  expired: number
  expiring: number
}

/** Counts per owner id, for a list's documents column. */
export function documentHealth(documents: readonly OwnedDocument[], on: string = today()): Map<string, DocumentHealth> {
  const health = new Map<string, DocumentHealth>()
  for (const doc of documents) {
    const entry = health.get(doc.owner_id) ?? { total: 0, expired: 0, expiring: 0 }
    entry.total += 1
    const { state } = expiryState(doc.expires_on, on)
    if (state === 'expired') entry.expired += 1
    if (state === 'expiring') entry.expiring += 1
    health.set(doc.owner_id, entry)
  }
  return health
}

/** "12 Mar 2027" for a YYYY-MM-DD date, without time-zone shifts. */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** "1.4 MB" / "820 KB". Display only. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** The upload limit and types the API enforces (api-contract §8); checked here first to save a round trip. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const ACCEPTED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const
