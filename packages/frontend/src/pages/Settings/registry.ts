import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { settingsKey } from '@/features/settings'
import { checkValue, formatDuration, parseDuration, type ParameterRules, type ParameterType } from '@/lib/parameterTypes'

// The settings registry (S-27, FMS-157, api-contract §16): every parameter with its type, rules, default, value
// and history. settings:write changes values; settings:define adds, edits, enables, disables and deletes.

export type ParameterStorage = 'settings' | 'rule_thresholds'

/** A parameter as GET /settings/definitions returns it. A secret's values are never in it. */
export interface Parameter {
  key: string
  label: string
  category: string
  description: string
  type: ParameterType
  rules: ParameterRules
  default_value: unknown
  value: unknown
  is_default: boolean
  is_enabled: boolean
  is_system: boolean
  is_secret: boolean
  has_value: boolean
  required_permission: string | null
  storage: ParameterStorage
  /** The ETag: sent back as If-Match, so a change made meanwhile is refused (412), not overwritten. */
  version: number
  value_changed_at: string | null
  value_changed_by: string | null
  value_changed_by_name: string | null
  created_at: string
  updated_at: string
}

/** One change in a parameter's history, newest first. */
export interface HistoryEntry {
  at: string
  change: 'value' | 'defined' | 'edited' | 'enabled' | 'disabled' | 'deleted'
  old_value: unknown
  new_value: unknown
  fields: string[]
  reason: string | null
  by: string | null
  by_name: string | null
}

/** A POST /settings/definitions. */
export interface NewParameter {
  key: string
  label: string
  category: string
  description: string
  type: ParameterType
  default_value: unknown
  rules: ParameterRules
  is_enabled: boolean
  is_secret: boolean
  required_permission: string | null
  value?: unknown
}

export type ParameterPatch = Partial<{
  label: string
  category: string
  description: string
  default_value: unknown
  rules: ParameterRules
  required_permission: string | null
  is_enabled: boolean
  value: unknown
  reason: string
}>

export const TYPE_LABELS: Record<ParameterType, string> = {
  text: 'Text',
  number: 'Number',
  integer: 'Whole number',
  boolean: 'On or off',
  dropdown: 'Dropdown',
  multi_select: 'Multi-select',
  duration: 'Duration',
  email: 'Email address',
  url: 'Web address',
  json: 'JSON',
}

export const parametersKey = ['settings', 'definitions'] as const
const historyKey = (key: string) => ['settings', 'definitions', key, 'history'] as const

export function useParameters() {
  const { api } = useAuth()
  return useQuery({ queryKey: parametersKey, queryFn: () => api.request<Parameter[]>('/settings/definitions') })
}

export function useParameterHistory(key: string | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: historyKey(key ?? ''),
    queryFn: () => api.request<HistoryEntry[]>(`/settings/definitions/${key}/history`),
    enabled: key !== null,
  })
}

/** After any change: the list, the history, and the values every screen reads (GET /settings). */
function useRefresh() {
  const queryClient = useQueryClient()
  return (key?: string) => {
    void queryClient.invalidateQueries({ queryKey: parametersKey })
    void queryClient.invalidateQueries({ queryKey: settingsKey, exact: true })
    void queryClient.invalidateQueries({ queryKey: ['settings', 'telemetry-rules'] })
    if (key) void queryClient.invalidateQueries({ queryKey: historyKey(key) })
  }
}

export function useDefineParameter() {
  const { api } = useAuth()
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (input: NewParameter) => api.request<Parameter>('/settings/definitions', { method: 'POST', json: input }),
    onSuccess: (p) => refresh(p.key),
  })
}

/** PATCH /settings/definitions/{key} with If-Match: the version the screen showed. */
export function useUpdateParameter() {
  const { api } = useAuth()
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({ key, version, patch }: { key: string; version: number; patch: ParameterPatch }) =>
      api.request<Parameter>(`/settings/definitions/${key}`, { method: 'PATCH', json: patch, headers: { 'If-Match': `"${version}"` } }),
    onSuccess: (p) => refresh(p.key),
  })
}

export function useDeleteParameter() {
  const { api } = useAuth()
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({ key, version }: { key: string; version: number }) =>
      api.request<void>(`/settings/definitions/${key}`, { method: 'DELETE', headers: { 'If-Match': `"${version}"` } }),
    onSuccess: (_d, { key }) => refresh(key),
  })
}

/** What the value editor holds while it is typed: text, or the options ticked. */
export type Draft = string | string[]

/** A value as its editor starts from. */
export function toDraft(type: ParameterType, value: unknown): Draft {
  if (type === 'multi_select') return Array.isArray(value) ? value.map(String) : []
  if (value === null || value === undefined) return ''
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'duration' && typeof value === 'number') return formatDuration(value)
  if (type === 'json') return JSON.stringify(value, null, 2)
  return String(value)
}

/** What was typed as the parameter's value, checked by the same validator as the API, or the message to show. */
export function fromDraft(type: ParameterType, rules: ParameterRules, draft: Draft): { ok: true; value: unknown } | { ok: false; error: string } {
  let value: unknown
  if (type === 'multi_select') value = Array.isArray(draft) ? draft : []
  else {
    const text = Array.isArray(draft) ? '' : draft
    switch (type) {
      case 'integer':
      case 'number': {
        const trimmed = text.trim().replace(',', '.')
        if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: false, error: type === 'integer' ? 'A whole number.' : 'A number, like 1.25.' }
        value = Number(trimmed)
        break
      }
      case 'boolean':
        value = text === 'true'
        break
      case 'duration': {
        const seconds = parseDuration(text)
        if (seconds === null) return { ok: false, error: 'A duration, like 90 (minutes), 1h 30m or 45s.' }
        value = seconds
        break
      }
      case 'json':
        try {
          value = JSON.parse(text)
        } catch {
          return { ok: false, error: 'Not valid JSON.' }
        }
        break
      default:
        value = type === 'text' ? text : text.trim()
    }
  }
  const check = checkValue(type, rules, value)
  return check.ok ? { ok: true, value } : { ok: false, error: check.message }
}

/** A value as the list and the history show it: with its unit, an option's label, a duration in words. */
export function formatValue(p: Pick<Parameter, 'type' | 'rules' | 'is_secret'>, value: unknown, hasValue = true): string {
  if (p.is_secret) return hasValue ? 'Set' : 'Not set'
  if (value === null || value === undefined) return 'Default'
  const unit = p.rules.unit
  switch (p.type) {
    case 'integer':
    case 'number': {
      const n = Number(value).toLocaleString('en-US', { maximumFractionDigits: p.rules.decimals ?? 10 })
      if (!unit) return n
      return unit === '%' || unit === '×' ? `${n}${unit}` : `${n} ${unit}`
    }
    case 'boolean':
      return value ? 'On' : 'Off'
    case 'dropdown':
      return p.rules.options?.find((o) => o.value === value)?.label ?? String(value)
    case 'multi_select': {
      const chosen = Array.isArray(value) ? value : []
      if (chosen.length === 0) return 'None'
      return chosen.map((v) => p.rules.options?.find((o) => o.value === v)?.label ?? String(v)).join(', ')
    }
    case 'duration':
      return typeof value === 'number' ? formatDuration(value) : String(value)
    case 'json':
      return JSON.stringify(value)
    default:
      return String(value) === '' ? 'Empty' : String(value)
  }
}
