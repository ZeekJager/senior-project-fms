import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { REPLAY_TICK_MS, TripMap } from './TripMap'
import type { LatLng } from './bounds'

// The track replay (FMS-95). jsdom has no SVG layout, so Leaflet would draw its lines on a canvas: the map's layers
// are stand-ins here that render their class and points, and there is no IntersectionObserver, so the map counts as
// on screen at once.
type Path = { positions?: unknown; center?: unknown; pathOptions?: { className?: string }; children?: ReactNode }
const { layer } = vi.hoisted(() => ({
  layer: ({ positions, center, pathOptions }: Path) => <i data-layer={pathOptions?.className} data-points={JSON.stringify(positions ?? center)} />,
}))
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TileLayer: () => null,
  ZoomControl: () => null,
  AttributionControl: () => null,
  Tooltip: () => null,
  Polyline: layer,
  CircleMarker: layer,
  useMap: () => ({ fitBounds: () => {}, invalidateSize: () => {}, getContainer: () => document.body }),
}))

const observer = globalThis.IntersectionObserver

beforeAll(() => {
  // @ts-expect-error: absent, as in an old browser; the map then opens at once.
  delete globalThis.IntersectionObserver
})
afterAll(() => {
  globalThis.IntersectionObserver = observer
})
afterEach(() => vi.useRealTimers())

const track: LatLng[] = [
  [9.0, 38.7],
  [9.01, 38.71],
  [9.02, 38.72],
  [9.03, 38.73],
]
// 06:00 to 06:03 UTC: 09:00 to 09:03 in Addis Ababa.
const times = track.map((_, i) => new Date(Date.UTC(2026, 10, 2, 6, i)).toISOString())

const renderMap = (withTimes = true) =>
  render(<TripMap label="Map of the trip" planned={{ origin: null, destination: null }} track={track} times={withTimes ? times : undefined} className="h-80" />)
const slider = () => screen.getByRole('slider', { name: 'Replay position' })
const vehicle = () => document.querySelector('[data-layer="trip-map-replay"]')?.getAttribute('data-points') ?? null
const driven = () => JSON.parse(document.querySelector('[data-layer="trip-map-track"]')!.getAttribute('data-points')!) as LatLng[]
const tick = (n = 1) => { for (let i = 0; i < n; i++) act(() => void vi.advanceTimersByTime(REPLAY_TICK_MS)) }

describe('TripMap replay (FMS-95)', () => {
  it('shows the whole track until moved; the slider puts the vehicle at a point, its time shown', () => {
    renderMap()
    expect(slider()).toHaveValue('3')
    expect(slider()).toHaveAttribute('aria-valuetext', '2 Nov, 09:03:00')
    expect(vehicle()).toBeNull()
    expect(driven()).toEqual(track)

    fireEvent.change(slider(), { target: { value: '1' } })
    expect(slider()).toHaveAttribute('aria-valuetext', '2 Nov, 09:01:00')
    expect(screen.getByText('2 Nov, 09:01:00')).toBeInTheDocument()
    expect(vehicle()).toBe(JSON.stringify(track[1]))
    expect(driven()).toEqual(track.slice(0, 2))
    // The road still ahead is drawn faint behind the part driven.
    expect(document.querySelector('[data-layer="trip-map-track trip-map-track--ahead"]')).not.toBeNull()

    // Back at the end: the whole track again.
    fireEvent.change(slider(), { target: { value: '3' } })
    expect(vehicle()).toBeNull()
  })

  it('Play moves the vehicle from the start to the end, then shows the whole track; Pause stops it', () => {
    vi.useFakeTimers()
    renderMap()
    fireEvent.click(screen.getByRole('button', { name: 'Replay the track' }))
    expect(slider()).toHaveValue('0')
    tick()
    expect(slider()).toHaveValue('1')
    expect(vehicle()).toBe(JSON.stringify(track[1]))

    fireEvent.click(screen.getByRole('button', { name: 'Pause replay' }))
    tick(5)
    expect(slider()).toHaveValue('1')

    fireEvent.click(screen.getByRole('button', { name: 'Replay the track' }))
    tick(5)
    expect(slider()).toHaveValue('3')
    expect(vehicle()).toBeNull()
    expect(screen.getByRole('button', { name: 'Replay the track' })).toBeInTheDocument()
  })

  it('without the times, or with one point, there is no replay', () => {
    const { unmount } = renderMap(false)
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    unmount()
    render(<TripMap label="One point" planned={{ origin: null, destination: null }} track={track.slice(0, 1)} times={times.slice(0, 1)} />)
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })
})
