import { useEffect, useRef } from 'react'

const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'wheel'] as const

/** Mouse moves arrive by the hundred; resetting the timer more than once a second gains nothing. */
const RESET_THROTTLE_MS = 1000

/** Calls `onIdle` once after `timeoutMs` without user input. Does nothing while `enabled` is false. */
export function useIdleTimeout(enabled: boolean, timeoutMs: number, onIdle: () => void): void {
  const onIdleRef = useRef(onIdle)
  useEffect(() => {
    onIdleRef.current = onIdle
  })

  useEffect(() => {
    if (!enabled) return

    let timer: ReturnType<typeof setTimeout>
    let lastReset = Date.now()
    const start = () => {
      timer = setTimeout(() => onIdleRef.current(), timeoutMs)
    }
    const onActivity = () => {
      const now = Date.now()
      if (now - lastReset < RESET_THROTTLE_MS) return
      lastReset = now
      clearTimeout(timer)
      start()
    }

    start()
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, onActivity, { passive: true }))
    return () => {
      clearTimeout(timer)
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, onActivity))
    }
  }, [enabled, timeoutMs])
}
