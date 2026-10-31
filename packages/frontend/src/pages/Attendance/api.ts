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

/** How a check-in or check-out was recorded (FMS-141): scanned at the depot, or entered by staff. */
export type CheckMethod = 'qr' | 'manual'

export const METHOD_LABELS: Record<CheckMethod, string> = { qr: 'QR scan', manual: 'By hand' }

/** A clock time in Addis Ababa, 24-hour: 07:52. */
export const clockTime = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))

export interface AttendanceRecord {
  id: string
  status: AttendanceStatus
  notes: string | null
  check_in_at: string | null
  check_in_method: CheckMethod | null
  check_out_at: string | null
  check_out_method: CheckMethod | null
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

/** GET /attendance/qr (FMS-141): the code the depot screen shows, for drivers to scan. */
export interface AttendanceCode {
  depot_id: string
  depot_name: string
  work_starts_at: string
  late_after_minutes: number
  code: string
  /** The server's clock when it answered; the windows below are on that clock. */
  generated_at: string
  issued_at: string
  refresh_at: string
  expires_at: string
}

/**
 * The depot's code, fetched again when the server says the next one is out (every 30 seconds), timed from the
 * server's clock so a wall tablet with a wrong clock still keeps up. `fetchedAt` is this device's clock at the answer.
 */
export function useAttendanceCode(depotId: string, enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['attendance', 'code', depotId],
    queryFn: async () => {
      const code = await api.request<AttendanceCode>(`/attendance/qr${depotId ? `?depot_id=${depotId}` : ''}`)
      return { ...code, fetchedAt: Date.now() }
    },
    refetchInterval: (query) => {
      const code = query.state.data
      if (!code) return 5_000
      return Math.max(1_000, Date.parse(code.refresh_at) - Date.parse(code.generated_at) - (Date.now() - code.fetchedAt) + 250)
    },
    refetchIntervalInBackground: true,
    enabled,
    retry: false,
    gcTime: 0,
  })
}

/**
 * Staff record a driver's arrival or leaving by hand (FMS-141), now: when the driver's phone has no signal.
 * Arriving creates the day's record if there is none (present, or late after the depot's grace).
 */
export function useRecordCheckTime() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ entry, kind }: { entry: RosterEntry; kind: 'check_in_at' | 'check_out_at' }) => {
      const now = new Date().toISOString()
      if (entry.attendance) return api.request<AttendanceRecord>(`/attendance/${entry.attendance.id}`, { method: 'PATCH', json: { [kind]: now } })
      return api.request<AttendanceRecord>('/attendance', { method: 'POST', json: { driver_id: entry.driver_id, date: entry.date, check_in_at: now } })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attendance'] }),
  })
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
