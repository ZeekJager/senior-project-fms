import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// Settings an administrator tunes without a code change (FMS-80, api-contract §6.5). Anyone signed in reads
// them: screens draw their lines from them, the health score's alert line first.

export type SettingKey = 'fuel_variance_threshold_pct' | 'health_alert_below' | 'expiry_warning_days'

/** A setting as GET /settings returns it. */
export interface Setting {
  key: SettingKey
  value: number
  default_value: number
  is_default: boolean
  unit: 'percent' | 'score' | 'days'
  min: number
  max: number
  updated_by: string | null
  updated_by_name: string | null
  updated_at: string | null
}

/** The defaults in code (CFG-3), used until GET /settings answers. */
export const SETTING_DEFAULTS: Record<SettingKey, number> = {
  fuel_variance_threshold_pct: 20,
  health_alert_below: 75,
  expiry_warning_days: 30,
}

export const settingsKey = ['settings'] as const

export function useSettings() {
  const { api } = useAuth()
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => api.request<Setting[]>('/settings'),
    // A change takes effect on the server within a minute; screens follow on the same clock.
    staleTime: 60_000,
  })
}

/** One setting's value: the default until the settings arrive, or if they cannot be read. */
export function useSetting(key: SettingKey): number {
  const settings = useSettings()
  return settings.data?.find((s) => s.key === key)?.value ?? SETTING_DEFAULTS[key]
}
