import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'

// The day roster (GET /attendance?date=) and attendance writes (api-contract §6.3, FMS-21).

export const ATTENDANCE_STATUSES = ['present', 'absent', 'on_leave', 'late', 'sick', 'other'] as const
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]

/** The three the roll call toggles; the rest come from other channels (driver app, notes). */
export const TOGGLE_STATUSES = ['present', 'absent', 'on_leave'] as const satisfies readonly AttendanceStatus[]

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  on_leave: 'On leave',
  late: 'Late',
  sick: 'Sick',
  other: 'Other',
}

export interface AttendanceRecord {
  id: string
  status: AttendanceStatus
  notes: string | null
  logged_by: string
  logged_by_name: string
  created_at: string
  updated_at: string
}

export interface RosterEntry {
  driver_id: string
  full_name: string
  email: string
  depot_id: string | null
  license_status: 'valid' | 'expiring_soon' | 'expired'
  date: string
  attendance: AttendanceRecord | null
}

export interface RosterFilters {
  date: string
  depotId: string
  status: AttendanceStatus | 'unmarked' | ''
  search: string
  page: number
}

export const ROSTER_PAGE_SIZE = 100

function rosterQuery(f: RosterFilters, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ date: f.date, page: String(f.page), page_size: String(ROSTER_PAGE_SIZE), ...extra })
  if (f.depotId) q.set('depot_id', f.depotId)
  if (f.search.trim()) q.set('search', f.search.trim())
  if (f.status && !('status' in extra)) q.set('status', f.status)
  return q.toString()
}

export const rosterKey = (f: RosterFilters) => ['attendance', 'roster', f] as const

export function useRoster(filters: RosterFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: rosterKey(filters),
    queryFn: async () => {
      const { data, meta } = await api.requestEnvelope<RosterEntry[]>(`/attendance?${rosterQuery(filters)}`)
      return { entries: data, meta: meta as unknown as PageMeta }
    },
  })
}

/** The day's totals per status (one tiny request each), for the stat cards. */
export function useDayCounts(filters: Omit<RosterFilters, 'status' | 'page'>) {
  const { api } = useAuth()
  const figures = { total: '', present: 'present', absent: 'absent', on_leave: 'on_leave', unmarked: 'unmarked' }
  const results = useQueries({
    queries: Object.entries(figures).map(([name, status]) => ({
      queryKey: ['attendance', 'counts', filters, name],
      queryFn: async () => {
        const q = new URLSearchParams(rosterQuery({ ...filters, status: '', page: 1 }))
        q.set('page_size', '1')
        if (status) q.set('status', status)
        const { meta } = await api.requestEnvelope<RosterEntry[]>(`/attendance?${q}`)
        return (meta as unknown as PageMeta).total_items
      },
    })),
  })
  const [total, present, absent, onLeave, unmarked] = results.map((r) => r.data)
  return { counts: { total, present, absent, onLeave, unmarked }, isLoading: results.some((r) => r.isPending) }
}

/**
 * Records a driver's status for the day: POST when there is no record yet,
 * PUT when there is. If someone else created the record in the meantime
 * (409 CONFLICT_ATTENDANCE_DUPLICATE), the roster is reloaded and the change
 * applied to their record, so the last choice wins.
 */
export function useMarkAttendance() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ entry, status }: { entry: RosterEntry; status: AttendanceStatus }) => {
      if (entry.attendance) {
        return api.request<AttendanceRecord>(`/attendance/${entry.attendance.id}`, { method: 'PUT', json: { status, notes: entry.attendance.notes } })
      }
      try {
        return await api.request<AttendanceRecord>('/attendance', { method: 'POST', json: { driver_id: entry.driver_id, date: entry.date, status } })
      } catch (err) {
        if ((err as { code?: string }).code !== 'CONFLICT_ATTENDANCE_DUPLICATE') throw err
        const [fresh] = await api.request<RosterEntry[]>(`/attendance?date=${entry.date}&driver_id=${entry.driver_id}`)
        if (!fresh?.attendance) throw err
        return api.request<AttendanceRecord>(`/attendance/${fresh.attendance.id}`, { method: 'PUT', json: { status, notes: fresh.attendance.notes } })
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attendance'] }),
  })
}
