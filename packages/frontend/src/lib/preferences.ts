import { useCallback, useSyncExternalStore } from 'react'

// Per-device preferences (table density, hidden columns, saved views, calendar):
// kept in localStorage, shared by every component that reads the same key, and
// safe when storage is blocked (the value then lasts for the visit only).

const listeners = new Map<string, Set<() => void>>()
const memory = new Map<string, string>()
const cache = new Map<string, { raw: string | null; value: unknown }>()

function readRaw(key: string): string | null {
  try {
    const stored = localStorage.getItem(key)
    if (stored !== null) return stored
  } catch {
    // Blocked: fall through to what this visit has kept in memory.
  }
  return memory.get(key) ?? null
}

function read<T>(key: string, fallback: T): T {
  const raw = readRaw(key)
  const hit = cache.get(key)
  if (hit && hit.raw === raw) return hit.value as T
  let value: T = fallback
  if (raw !== null) {
    try {
      value = JSON.parse(raw) as T
    } catch {
      value = fallback
    }
  }
  cache.set(key, { raw, value })
  return value
}

export function setPreference<T>(key: string, value: T): void {
  const raw = JSON.stringify(value)
  memory.set(key, raw)
  try {
    localStorage.setItem(key, raw)
  } catch {
    // The preference still applies for this visit.
  }
  listeners.get(key)?.forEach((l) => l())
}

/** A value kept on this device. `fallback` must be a stable reference (a constant), or every render looks like a change. */
export function usePreference<T>(key: string, fallback: T): [T, (value: T) => void] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
      return () => set.delete(listener)
    },
    [key],
  )
  const value = useSyncExternalStore(subscribe, () => read(key, fallback), () => fallback)
  const set = useCallback((next: T) => setPreference(key, next), [key])
  return [value, set]
}

/** The value now, outside React (for formatting helpers). */
export function getPreference<T>(key: string, fallback: T): T {
  return read(key, fallback)
}

export type CalendarSystem = 'gregorian' | 'ethiopic'
export const CALENDAR_KEY = 'fms-calendar'
