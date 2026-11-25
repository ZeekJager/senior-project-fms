import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { API_BASE } from '@/lib/api/client'

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

// Resources (FMS-163, docs/observability.md): GET /system/metrics, read from Prometheus by the API (the browser never
// calls it), refreshed every 15 s; the maintenance windows and the capacity report.

export type ResourceRange = '1h' | '24h' | '7d' | '30d' | '12m'
export const RESOURCE_RANGES: readonly { value: ResourceRange; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '12m', label: '12 months' },
]

export type ResourceStatus = 'ok' | 'warning' | 'critical' | 'unknown'

export interface ResourceMetric {
  value: number | null
  sampled_at: string | null
  status: ResourceStatus
  /** [unix seconds, value] */
  series: [number, number][]
}

export interface ResourceTile {
  name: string
  status: ResourceStatus
  cpu: ResourceMetric
  memory: ResourceMetric
  disk: ResourceMetric | null
  network_in: ResourceMetric
  network_out: ResourceMetric
}

export interface Lines {
  warning: number
  critical: number
}

export interface SystemMetrics {
  range: ResourceRange
  step_seconds: number
  generated_at: string
  source: { configured: boolean; reachable: boolean; error?: string }
  thresholds: { cpu_pct: Lines; memory_pct: Lines; disk_pct: Lines; db_connections_pct: Lines; replica_lag_seconds: Lines; error_pct: Lines; p95_ms: Lines; gps_silence_minutes: number }
  hosts: ResourceTile[]
  services: ResourceTile[]
  application: {
    request_rate_per_minute: ResourceMetric
    error_pct: ResourceMetric
    p95_ms: ResourceMetric
    gps_points_per_minute: ResourceMetric
    sockets: ResourceMetric
    job_failures_last_hour: ResourceMetric
  } | null
  database: {
    connections_pct: ResourceMetric
    transactions_per_second: ResourceMetric
    cache_hit_pct: ResourceMetric
    replica_lag_seconds: ResourceMetric
    slowest_queries: { query: string; calls: number; mean_ms: number; total_ms: number }[]
  } | null
}

export interface MaintenanceWindow {
  id: string
  hosts: string[]
  starts_at: string
  ends_at: string
  reason: string
  cancelled_at: string | null
  in_force: boolean
  suppressed: number
  version: number
}

/** Prometheus scrapes every 15 s: the tab reads as often, so a value is at most about 30 s old. */
const RESOURCES_REFRESH_MS = 15_000

export function useSystemMetrics(range: ResourceRange) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['system', 'metrics', range],
    queryFn: () => api.request<SystemMetrics>(`/system/metrics?range=${range}`),
    placeholderData: keepPreviousData,
    refetchInterval: RESOURCES_REFRESH_MS,
  })
}

export function useMaintenanceWindows() {
  const { api } = useAuth()
  return useQuery({ queryKey: ['system', 'maintenance-windows'], queryFn: () => api.request<MaintenanceWindow[]>('/system/maintenance-windows'), refetchInterval: 60_000 })
}

export function useCreateMaintenanceWindow() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (w: { hosts: string[]; starts_at: string; ends_at: string; reason: string }) => api.request<MaintenanceWindow>('/system/maintenance-windows', { method: 'POST', json: w }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['system', 'maintenance-windows'] }),
  })
}

export function useCancelMaintenanceWindow() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.request<MaintenanceWindow>(`/system/maintenance-windows/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['system', 'maintenance-windows'] }),
  })
}

/** The capacity report as a PDF, by a download link (as the reports are: the session is checked first). */
export function useDownloadCapacityReport() {
  const { api } = useAuth()
  return useMutation({
    mutationFn: async () => {
      await api.request('/auth/me')
      const link = document.createElement('a')
      link.href = `${API_BASE}/system/capacity-report?format=pdf`
      link.download = ''
      document.body.appendChild(link)
      link.click()
      link.remove()
    },
  })
}
