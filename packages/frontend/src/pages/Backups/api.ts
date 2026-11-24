import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// Database backups (api-contract §5.3, FMS-144): GET and POST /system/backups, and a signed download link. Admin only.
// Point-in-time recovery (FMS-108): meta.pitr, and the base backups of GET /system/base-backups.

export type BackupStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired'

export interface Backup {
  id: string
  kind: 'scheduled' | 'manual'
  status: BackupStatus
  database_name: string
  requested_by: { id: string; name: string } | null
  requested_at: string
  started_at: string | null
  finished_at: string | null
  size_bytes: number | null
  checksum_sha256: string | null
  error: string | null
  expires_at: string | null
  downloadable: boolean
}

export interface RestoreDrill {
  id: string
  backup_id: string
  target_database: string
  status: 'succeeded' | 'failed'
  started_at: string
  finished_at: string
  tables_restored: number | null
  error: string | null
  run_by: string
}

export interface BackupsMeta {
  page: number
  page_size: number
  total_items: number
  total_pages: number
  available: boolean
  retention_days: number
  last_succeeded_at: string | null
  last_restore_drill: RestoreDrill | null
  pitr: PitrOverview
}

// Point-in-time recovery (FMS-108, docs/backups.md): meta.pitr and GET /system/base-backups.

export type BackupCondition =
  | 'archiving_failing'
  | 'repository_unreachable'
  | 'offsite_behind'
  | 'status_stale'
  | 'base_backup_missing'
  | 'drill_failed'
  | 'drill_overdue'

export interface BackupFinding {
  condition: BackupCondition
  severity: 'critical' | 'high'
  repo: number | null
  since: string
  message: string
}

export interface PitrRepository {
  repo: number
  location: 'local' | 'offsite'
  status: 'ok' | 'error'
  message: string | null
  encrypted: boolean
  base_backups: number
  recoverable_from: string | null
  recoverable_to: string | null
  checked_at: string
}

export interface PitrDrill {
  id: string
  base_backup_label: string
  recovery_target: string | null
  status: 'succeeded' | 'failed'
  started_at: string
  finished_at: string
  tables_restored: number | null
  rto_seconds: number | null
  checks: { table: string; live_rows: number; restored_rows: number | null; match: boolean }[] | null
  error: string | null
  run_by: string
}

export interface PitrOverview {
  enabled: boolean
  recoverable_from: string | null
  recoverable_to: string | null
  archiving: { last_archived_at: string | null; last_failed_at: string | null; failing_since: string | null }
  repositories: PitrRepository[]
  last_base_backup_at: string | null
  last_drill: PitrDrill | null
  findings: BackupFinding[]
}

export interface BaseBackup {
  id: string
  label: string | null
  type: 'full' | 'diff' | 'incr'
  triggered_by: 'schedule' | 'first-start' | 'manual'
  repo: number
  location: 'local' | 'offsite'
  status: 'running' | 'succeeded' | 'failed' | 'expired'
  started_at: string
  finished_at: string | null
  size_bytes: number | null
  repo_size_bytes: number | null
  error: string | null
}

export interface PageMeta {
  page: number
  page_size: number
  total_items: number
  total_pages: number
}

export const BACKUPS_PAGE_SIZE = 20

const underWay = (b: Backup) => b.status === 'queued' || b.status === 'running'

export function useBackups(page: number) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['system', 'backups', page],
    queryFn: async () => {
      const res = await api.requestEnvelope<Backup[]>(`/system/backups?page=${page}&page_size=${BACKUPS_PAGE_SIZE}`)
      return { items: res.data, meta: res.meta as unknown as BackupsMeta }
    },
    placeholderData: keepPreviousData,
    // A backup under way is watched until it ends; otherwise the list is still.
    refetchInterval: (query) => (query.state.data?.items.some(underWay) ? 3_000 : false),
  })
}

export const BASE_BACKUPS_PAGE_SIZE = 10

export function useBaseBackups(page: number) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['system', 'base-backups', page],
    queryFn: async () => {
      const res = await api.requestEnvelope<BaseBackup[]>(`/system/base-backups?page=${page}&page_size=${BASE_BACKUPS_PAGE_SIZE}`)
      return { items: res.data, meta: res.meta as unknown as PageMeta }
    },
    placeholderData: keepPreviousData,
    // The database container takes them; one under way is watched until it ends.
    refetchInterval: (query) => (query.state.data?.items.some((b) => b.status === 'running') ? 10_000 : false),
  })
}

export function useStartBackup() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.request<Backup>('/system/backups', { method: 'POST', json: {} }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['system', 'backups'] }),
  })
}

export function useDownloadLink() {
  const { api } = useAuth()
  return useMutation({
    mutationFn: (id: string) => api.request<{ url: string; expires_at: string; filename: string }>(`/system/backups/${id}/download-link`, { method: 'POST', json: {} }),
  })
}

/** Starts the browser's download of a signed link (the server answers with an attachment, so the page stays). */
export function startDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
}
