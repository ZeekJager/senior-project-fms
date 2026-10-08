import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdleTimeout } from './useIdleTimeout'

const THIRTY_MINUTES = 30 * 60 * 1000

describe('useIdleTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires after 30 minutes without input', () => {
    const onIdle = vi.fn()
    renderHook(() => useIdleTimeout(true, THIRTY_MINUTES, onIdle))

    vi.advanceTimersByTime(THIRTY_MINUTES - 1)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('restarts the clock on activity', () => {
    const onIdle = vi.fn()
    renderHook(() => useIdleTimeout(true, THIRTY_MINUTES, onIdle))

    vi.advanceTimersByTime(THIRTY_MINUTES - 1000)
    act(() => {
      window.dispatchEvent(new Event('keydown'))
    })
    vi.advanceTimersByTime(THIRTY_MINUTES - 1000)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('does nothing while disabled', () => {
    const onIdle = vi.fn()
    renderHook(() => useIdleTimeout(false, THIRTY_MINUTES, onIdle))

    vi.advanceTimersByTime(THIRTY_MINUTES * 2)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('stops when the user signs out (disabled) or the screen unmounts', () => {
    const onIdle = vi.fn()
    const { rerender, unmount } = renderHook(({ enabled }) => useIdleTimeout(enabled, THIRTY_MINUTES, onIdle), {
      initialProps: { enabled: true },
    })

    rerender({ enabled: false })
    vi.advanceTimersByTime(THIRTY_MINUTES)
    expect(onIdle).not.toHaveBeenCalled()

    rerender({ enabled: true })
    unmount()
    vi.advanceTimersByTime(THIRTY_MINUTES)
    expect(onIdle).not.toHaveBeenCalled()
  })
})
