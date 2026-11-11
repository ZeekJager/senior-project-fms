import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { settingsKey, type Setting, type SettingKey } from '@/features/settings'

// The settings screen (S-27, FMS-80, api-contract §6.5): settings:write, admin only.

/** The telemetry rules' thresholds: speeding and idling (FMS-46), route deviation (FMS-90), and the trip delay alert (FMS-147). */
export interface Thresholds {
  speed_limit_kmh: number
  speeding_pings: number
  clear_pings: number
  idle_minutes: number
  route_deviation_m: number
  route_deviation_pings: number
  /** Minutes past its scheduled end a trip is expected before it is late, and before it is urgent (above the first). */
  trip_delay_minutes: number
  trip_delay_urgent_minutes: number
}

export interface ThresholdsRow extends Thresholds {
  updated_by: string | null
  updated_by_name: string | null
  updated_at: string | null
}

/** GET /settings/telemetry-rules: the fleet's, and each depot's that differ. */
export interface RuleThresholds {
  fleet: ThresholdsRow
  depots: (ThresholdsRow & { depot_id: string })[]
}

export type ThresholdKey = keyof Thresholds

/** Each threshold's range, as tracking.rule_thresholds checks it (migrations 035, 060 and 068). */
export const THRESHOLD_LIMITS: Record<ThresholdKey, { min: number; max: number }> = {
  speed_limit_kmh: { min: 20, max: 200 },
  speeding_pings: { min: 1, max: 20 },
  clear_pings: { min: 1, max: 20 },
  idle_minutes: { min: 1, max: 120 },
  route_deviation_m: { min: 100, max: 5000 },
  route_deviation_pings: { min: 1, max: 20 },
  trip_delay_minutes: { min: 5, max: 240 },
  trip_delay_urgent_minutes: { min: 10, max: 720 },
}

/** The fleet's starting thresholds, before anyone changed them. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  speed_limit_kmh: 80,
  speeding_pings: 3,
  clear_pings: 3,
  idle_minutes: 5,
  route_deviation_m: 500,
  route_deviation_pings: 3,
  trip_delay_minutes: 15,
  trip_delay_urgent_minutes: 60,
}

const thresholdsKey = ['settings', 'telemetry-rules'] as const

export function useRuleThresholds() {
  const { api } = useAuth()
  return useQuery({ queryKey: thresholdsKey, queryFn: () => api.request<RuleThresholds>('/settings/telemetry-rules') })
}

/** PUT the fleet's thresholds (depotId null) or a depot's own. Answers with them all. */
export function useSaveThresholds() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ depotId, thresholds }: { depotId: string | null; thresholds: Thresholds }) =>
      api.request<RuleThresholds>(depotId ? `/settings/telemetry-rules/depots/${depotId}` : '/settings/telemetry-rules/fleet', { method: 'PUT', json: thresholds }),
    onSuccess: (data) => queryClient.setQueryData(thresholdsKey, data),
  })
}

/** DELETE a depot's own thresholds: it follows the fleet's again. */
export function useRemoveDepotThresholds() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (depotId: string) => api.request<void>(`/settings/telemetry-rules/depots/${depotId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: thresholdsKey }),
  })
}

/** PATCH /settings: the values to change; null goes back to the default. Answers with every setting. */
export function useSaveSettings() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (changes: Partial<Record<SettingKey, number | null>>) => api.request<Setting[]>('/settings', { method: 'PATCH', json: changes }),
    onSuccess: (data) => queryClient.setQueryData(settingsKey, data),
  })
}

/** A whole number within [min, max] from what was typed, or the message to show. */
export function parseWhole(text: string, min: number, max: number): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!/^\d{1,4}$/.test(trimmed)) return { ok: false, error: `A whole number from ${min} to ${max}.` }
  const value = Number(trimmed)
  if (value < min || value > max) return { ok: false, error: `From ${min} to ${max}.` }
  return { ok: true, value }
}
