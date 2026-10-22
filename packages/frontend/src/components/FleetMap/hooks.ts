import { useEffect, useState, type RefObject } from 'react'

/**
 * Whether the element is on screen now. False until the observer first reports, so nothing that
 * waits for it (the map's tiles) starts loading for an element that is scrolled out of view.
 * A browser without IntersectionObserver counts as always visible.
 */
export function useInViewport(ref: RefObject<Element>): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) setInView(entry.isIntersecting)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return inView
}

/**
 * The current time. Read on every render, so a new ping is judged against the real clock, and the
 * component re-renders every `intervalMs` so a marker turns grey when pings stop and nothing else changes.
 */
export function useNow(intervalMs: number): number {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return Date.now()
}
