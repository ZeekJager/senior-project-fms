import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// System health (api-contract §3.8, FMS-143): GET /system/health and /system/health/history. Admin only (system:read).

export type HealthWindow = '24h' | '7d' | '30d'
export const WINDOWS: readonly { value: HealthWindow; label: string; minutes: number }[] = [
  { value: '24h', label: '24 hours', minutes: 24 * 60 },
  { value: '7d', label: '7 days', minutes: 7 * 24 * 60 },
  { value: '30d', label: '30 days', minutes: 30 * 24 * 60 },
]

export type ComponentStatus = 'ok' | 'down' | 'disabled' | 'no_data'

export interface Uptime {
  uptime_pct: number | null
  ok_minutes: number
  down_minutes: number
  disabled_minutes: number
  no_data_minutes: number
}

export interface ComponentHealth {
  component: string
  kind: 'api' | 'database' | 'replica' | 'redis' | 'ai_service' | 'provider'
  label: string
  status: ComponentStatus
  checked_at: string | null
  latency_ms: number | null
  error: string | null
  uptime: Record<HealthWindow, Uptime>
}

export interface Outage {
  component: string
  label: string
  started_at: string
  ended_at: string | null
  duration_minutes: number
  error: string | null
}

export interface FailedJobRun {
  job: string
  run_key: string
  attempts: number
  started_at: string
  failed_at: string
  error: string | null
}

export interface SystemHealth {
  generated_at: string
  window_end: string
  sampled_from: string | null
  components: ComponentHealth[]
  outages: Outage[]
  outages_total: number
  failed_jobs: FailedJobRun[]
  failed_jobs_total: number
}

export interface RequestStats {
  requests: number
  errors_5xx: number
  error_rate_pct: number | null
  p95_ms: number | null
}

export interface TimelineCell {
  start: string
  ok_minutes: number
  down_minutes: number
  disabled_minutes: number
  no_data_minutes: number
}

export interface SystemHealthHistory {
  window: HealthWindow
  from: string
  to: string
  bucket_minutes: number
  requests: RequestStats & { cells: (RequestStats & { start: string })[] }
  components: { component: string; label: string; cells: TimelineCell[] }[]
}

/** The server samples once a minute: read again as often. */
const REFRESH_MS = 60_000

export function useSystemHealth() {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => api.request<SystemHealth>('/system/health'),
    refetchInterval: REFRESH_MS,
  })
}

export function useSystemHealthHistory(window: HealthWindow) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['system', 'health', 'history', window],
    queryFn: () => api.request<SystemHealthHistory>(`/system/health/history?window=${window}`),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
  })
}
