import type { LicenseStatus } from './types'

export const PAGE_SIZES = [25, 50, 100] as const
export const SORT_KEYS = ['full_name', 'license_expiry', 'license_number'] as const
export type SortKey = (typeof SORT_KEYS)[number]

/** The list's filters, kept in the URL so a view can be bookmarked and Back works, without a reload. */
export interface DriverFilters {
  search: string
  depotId: string
  licence: LicenseStatus | ''
  retired: boolean
  page: number
  pageSize: number
  sortBy: SortKey
  sortOrder: 'asc' | 'desc'
}

const LICENCE_VALUES: readonly string[] = ['valid', 'expiring_soon', 'expired']

export function readFilters(params: URLSearchParams): DriverFilters {
  const page = Number.parseInt(params.get('page') ?? '', 10)
  const size = Number.parseInt(params.get('size') ?? '', 10)
  const licence = params.get('licence') ?? ''
  const sort = params.get('sort') ?? ''
  return {
    search: params.get('q') ?? '',
    depotId: params.get('depot') ?? '',
    licence: LICENCE_VALUES.includes(licence) ? (licence as LicenseStatus) : '',
    retired: params.get('retired') === '1',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : PAGE_SIZES[0],
    // Soonest expiry first by default: the screen exists to catch expiring licences.
    sortBy: (SORT_KEYS as readonly string[]).includes(sort) ? (sort as SortKey) : 'license_expiry',
    sortOrder: params.get('order') === 'desc' ? 'desc' : 'asc',
  }
}

/** Only non-default values are written, so the plain page URL stays clean. */
export function writeFilters(f: DriverFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (f.search) params.set('q', f.search)
  if (f.depotId) params.set('depot', f.depotId)
  if (f.licence) params.set('licence', f.licence)
  if (f.retired) params.set('retired', '1')
  if (f.page > 1) params.set('page', String(f.page))
  if (f.pageSize !== PAGE_SIZES[0]) params.set('size', String(f.pageSize))
  if (f.sortBy !== 'license_expiry') params.set('sort', f.sortBy)
  if (f.sortOrder === 'desc') params.set('order', 'desc')
  return params
}

/** GET /drivers query string (api-contract §6.3). */
export function driverQuery(f: DriverFilters): string {
  const q = new URLSearchParams({ page: String(f.page), page_size: String(f.pageSize), sort_by: f.sortBy, sort_order: f.sortOrder })
  if (f.search.trim()) q.set('search', f.search.trim())
  if (f.depotId) q.set('depot_id', f.depotId)
  if (f.licence) q.set('license_status', f.licence)
  if (f.retired) q.set('status', 'retired')
  return q.toString()
}

export const hasActiveFilters = (f: DriverFilters) => Boolean(f.search || f.depotId || f.licence || f.retired)

/** Same spelling the API stores: trimmed, single spaces, upper case. */
export function normalizeLicence(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase()
}
