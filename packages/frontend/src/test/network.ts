import { act } from '@testing-library/react'

/**
 * The phone loses its signal. Screens listen for `offline` in effects, which
 * React runs after the screen paints, on its own scheduler: one macrotask
 * first, so a listener attached by a screen that just appeared hears it.
 * (Firing it straight after a `findBy*` raced those effects on slow CI runners.)
 */
export async function goOffline(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  act(() => void window.dispatchEvent(new Event('offline')))
}
