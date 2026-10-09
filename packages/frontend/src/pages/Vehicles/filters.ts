import { VEHICLE_STATUSES, type VehicleStatus } from './types'

export const PAGE_SIZES = [25, 50, 100] as const
export const SORT_KEYS = ['registration_number', 'updated_at'] as const
export type SortKey = (typeof SORT_KEYS)[number]

/** The list's filters, kept in the URL so a view can be bookmarked and Back works, without a reload. */
export interface VehicleFilters {
  search: string
  depotId: string
  status: VehicleStatus | ''
  flagged: boolean
  page: number
  pageSize: number
  sortBy: SortKey
  sortOrder: 'asc' | 'desc'
}

const oneOf = <T extends string>(values: readonly T[], value: string | null, fallback: T): T =>
  value !== null && (values as readonly string[]).includes(value) ? (value as T) : fallback

export function readFilters(params: URLSearchParams): VehicleFilters {
  const page = Number.parseInt(params.get('page') ?? '', 10)
  const size = Number.parseInt(params.get('size') ?? '', 10)
  return {
    search: params.get('q') ?? '',
    depotId: params.get('depot') ?? '',
    status: oneOf<VehicleStatus | ''>(['', ...VEHICLE_STATUSES], params.get('status'), ''),
    flagged: params.get('flagged') === '1',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : PAGE_SIZES[0],
    sortBy: oneOf(SORT_KEYS, params.get('sort'), 'registration_number'),
    sortOrder: params.get('order') === 'desc' ? 'desc' : 'asc',
  }
}

/** Only non-default values are written, so the plain page URL stays clean. */
export function writeFilters(filters: VehicleFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.search) params.set('q', filters.search)
  if (filters.depotId) params.set('depot', filters.depotId)
  if (filters.status) params.set('status', filters.status)
  if (filters.flagged) params.set('flagged', '1')
  if (filters.page > 1) params.set('page', String(filters.page))
  if (filters.pageSize !== PAGE_SIZES[0]) params.set('size', String(filters.pageSize))
  if (filters.sortBy !== 'registration_number') params.set('sort', filters.sortBy)
  if (filters.sortOrder === 'desc') params.set('order', 'desc')
  return params
}

/** GET /vehicles query string for these filters (api-contract §6.2). */
export function vehicleQuery(filters: VehicleFilters): string {
  const q = new URLSearchParams({
    page: String(filters.page),
    page_size: String(filters.pageSize),
    sort_by: filters.sortBy,
    sort_order: filters.sortOrder,
  })
  if (filters.search.trim()) q.set('search', filters.search.trim())
  if (filters.depotId) q.set('depot_id', filters.depotId)
  if (filters.status) q.set('status', filters.status)
  if (filters.flagged) q.set('maintenance_flag', 'true')
  return q.toString()
}

export const hasActiveFilters = (f: VehicleFilters) => Boolean(f.search || f.depotId || f.status || f.flagged)

/** Same spelling the API stores: trimmed, single spaces, upper case (api-contract §17). */
export function normalizePlate(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase()
}
