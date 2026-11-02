import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// Database backups (api-contract §5.3, FMS-144): GET and POST /system/backups, and a signed download link. Admin only.

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
