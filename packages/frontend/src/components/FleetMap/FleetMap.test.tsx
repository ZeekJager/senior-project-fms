import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type L from 'leaflet'
import { createRef } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FleetMap, IDLE_AFTER_MS, OFFLINE_AFTER_MS, type FleetMapVehicle } from '.'

// Leaflet runs in jsdom, with three stand-ins: a size for every element (jsdom lays nothing out, and
// Leaflet loads no tiles into a 0x0 map), an IntersectionObserver the test scrolls by hand, and a
// record of every <img> src set, which is when a browser sends the tile request.

const requested: string[] = []
const observers = new Set<IntersectionObserverCallback>()
const scroll = (onScreen: boolean) =>
  act(() => observers.forEach((cb) => cb([{ isIntersecting: onScreen } as IntersectionObserverEntry], {} as IntersectionObserver)))
const tiles = () => requested.filter((url) => url.includes('tile.openstreetmap.org'))

const srcProperty = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
const sizes = ['clientWidth', 'clientHeight'] as const
const sizeProperties = sizes.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))

beforeAll(() => {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get: srcProperty.get,
    set(value: string) {
      requested.push(value)
      srcProperty.set!.call(this, value)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
})
afterAll(() => {
  Object.defineProperty(HTMLImageElement.prototype, 'src', srcProperty)
  sizes.forEach((name, i) => (sizeProperties[i] ? Object.defineProperty(HTMLElement.prototype, name, sizeProperties[i]!) : delete (HTMLElement.prototype as never)[name]))
})

beforeEach(() => {
  requested.length = 0
  observers.clear()
  // Leaflet keeps the page from jumping when the map takes focus; jsdom has no scrolling.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe() {
        observers.add(this.cb)
      }
      disconnect() {
        observers.delete(this.cb)
      }
    },
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const bole: FleetMapVehicle = { vehicleId: 'veh-bole', plateNumber: 'AA 3-12345', lat: 8.9806, lng: 38.7578, speedKmh: 46, heading: 90, lastSeen: ago(5_000) }
const piassa: FleetMapVehicle = { vehicleId: 'veh-piassa', plateNumber: 'AA 3-20212', lat: 9.0336, lng: 38.7496, speedKmh: 28, lastSeen: ago(8_000) }

const marker = (plate: string) => screen.getByRole('button', { name: new RegExp(`^${plate}:`) })
const stateOf = (plate: string) => marker(plate).querySelector('[data-state]')?.getAttribute('data-state')

describe('FleetMap', () => {
  it('shows OpenStreetMap tiles over Addis Ababa at zoom 12 once on screen', () => {
    const { container } = render(<FleetMap vehicles={[]} className="h-96" />)
    scroll(true)

    expect(container.querySelector('.leaflet-container')).not.toBeNull()
    // The tile that holds the city centre (9.0108 N, 38.7613 E) at zoom 12 is x 2489, y 1945.
    expect(tiles()).toContain('https://tile.openstreetmap.org/12/2489/1945.png')
    expect(tiles().every((url) => url.startsWith('https://tile.openstreetmap.org/12/'))).toBe(true)
    expect(screen.getByRole('region', { name: 'Fleet map' })).toHaveTextContent('OpenStreetMap contributors')
    expect(screen.getByText('No vehicles reporting yet')).toBeInTheDocument()
  })

  it('requests no tiles before it is on screen, while scrolled away, or after unmounting', () => {
    const map = createRef<L.Map>()
    const { container, unmount } = render(<FleetMap ref={map} vehicles={[bole]} className="h-96" />)
    expect(tiles()).toEqual([])
    expect(container.querySelector('.leaflet-container')).toBeNull()

    scroll(true)
    expect(tiles().length).toBeGreaterThan(0)

    scroll(false)
    requested.length = 0
    expect(container.querySelectorAll('.leaflet-tile')).toHaveLength(0)
    act(() => {
      map.current!.setView([9.03, 38.74], 14, { animate: false })
    })
    expect(tiles()).toEqual([])
    // The markers stay, so the view is right the moment it scrolls back.
    expect(marker('AA 3-12345')).toBeInTheDocument()

    scroll(true)
    expect(tiles().length).toBeGreaterThan(0)
    expect(tiles().every((url) => url.includes('/14/'))).toBe(true)

    unmount()
    requested.length = 0
    expect(observers.size).toBe(0)
    expect(tiles()).toEqual([])
  })

  it('fits the view to the vehicles on the first report, and not again after', () => {
    const map = createRef<L.Map>()
    const adama: FleetMapVehicle = { ...piassa, vehicleId: 'veh-adama', plateNumber: 'OR 3-55501', lat: 8.54, lng: 39.27 }
    const { rerender } = render(<FleetMap ref={map} vehicles={[]} className="h-96" />)
    scroll(true)
    rerender(<FleetMap ref={map} vehicles={[bole, adama]} className="h-96" />)
    const bounds = map.current!.getBounds()
    expect(bounds.contains([bole.lat, bole.lng]) && bounds.contains([adama.lat, adama.lng])).toBe(true)

    act(() => {
      map.current!.setView([9.03, 38.74], 15, { animate: false })
    })
    rerender(<FleetMap ref={map} vehicles={[{ ...bole, lat: 8.99 }, adama]} className="h-96" />)
    expect(map.current!.getZoom()).toBe(15)
  })

  it('turns a vehicle amber after more than 5 minutes at 0 km/h, and green again when it moves', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { rerender } = render(<FleetMap vehicles={[{ ...bole, speedKmh: 0, lastSeen: ago(0) }]} />)
    scroll(true)
    expect(stateOf('AA 3-12345')).toBe('stopped')

    // Still pinging, still at 0 km/h, 5 min 10 s after the first stopped ping.
    vi.setSystemTime(Date.now() + IDLE_AFTER_MS + 10_000)
    rerender(<FleetMap vehicles={[{ ...bole, speedKmh: 0, lastSeen: ago(0) }]} />)
    expect(stateOf('AA 3-12345')).toBe('idling')
    expect(marker('AA 3-12345')).toHaveAccessibleName(/Idling, 0 km\/h/)

    rerender(<FleetMap vehicles={[{ ...bole, speedKmh: 12, lastSeen: ago(0) }]} />)
    expect(stateOf('AA 3-12345')).toBe('moving')
  })

  it("uses the server's stoppedSince, so a vehicle idling before the page opened is amber at once", () => {
    render(<FleetMap vehicles={[{ ...bole, speedKmh: 0, stoppedSince: ago(IDLE_AFTER_MS + 60_000) }]} />)
    scroll(true)
    expect(stateOf('AA 3-12345')).toBe('idling')
  })

  it('turns a vehicle grey when it has not pinged for 2 minutes, without new data arriving', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    render(<FleetMap vehicles={[{ ...bole, lastSeen: ago(0) }, { ...piassa, lastSeen: ago(OFFLINE_AFTER_MS + 30_000) }]} />)
    scroll(true)
    expect(stateOf('AA 3-12345')).toBe('moving')
    expect(stateOf('AA 3-20212')).toBe('offline')

    act(() => {
      vi.advanceTimersByTime(OFFLINE_AFTER_MS + 10_000)
    })
    expect(stateOf('AA 3-12345')).toBe('offline')
    const legend = screen.getByRole('list', { name: 'Map legend' })
    expect(within(legend).getByText('No ping 2+ min').nextSibling).toHaveTextContent('2')
  })

  it('shows a reported breakdown in red', () => {
    render(<FleetMap vehicles={[{ ...bole, breakdown: true }, piassa]} />)
    scroll(true)
    expect(stateOf('AA 3-12345')).toBe('breakdown')
    expect(stateOf('AA 3-20212')).toBe('moving')
  })

  it('calls onVehicleClick with the vehicle id on a click, Enter or Space', async () => {
    const user = userEvent.setup()
    const onVehicleClick = vi.fn()
    render(<FleetMap vehicles={[bole, piassa]} onVehicleClick={onVehicleClick} />)
    scroll(true)

    // fireEvent, not user.click: Leaflet copies a click with for...in, and user-event's coordinates are
    // non-enumerable own properties, so the copy would have none (a browser's event copies fine).
    fireEvent.click(marker('AA 3-20212'), { clientX: 400, clientY: 300 })
    expect(onVehicleClick).toHaveBeenLastCalledWith('veh-piassa')

    marker('AA 3-12345').focus()
    await user.keyboard('{Enter}')
    expect(onVehicleClick).toHaveBeenLastCalledWith('veh-bole')
    marker('AA 3-20212').focus()
    await user.keyboard(' ')
    expect(onVehicleClick).toHaveBeenLastCalledWith('veh-piassa')
    expect(onVehicleClick).toHaveBeenCalledTimes(3)
  })

  it('shows the plate, speed and last seen on hover', async () => {
    const user = userEvent.setup()
    // Seen as the test renders: the fixture's time is from when the file loaded, which a slow run leaves behind.
    render(<FleetMap vehicles={[{ ...bole, lastSeen: ago(0) }]} />)
    scroll(true)

    await user.hover(marker('AA 3-12345'))
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('AA 3-12345')
    expect(tooltip).toHaveTextContent('Speed46 km/h')
    expect(tooltip).toHaveTextContent('Last seenJust now')
    expect(tooltip).toHaveTextContent('StatusMoving')
  })

  it('opens a tooltip below a marker at the top edge, so it is not cut off', async () => {
    const user = userEvent.setup()
    const map = createRef<L.Map>()
    render(<FleetMap ref={map} vehicles={[bole, piassa]} />)
    scroll(true)
    // Fitted to both, Piassa (north) is about 145px from the top; move the view so it sits at the edge.
    act(() => {
      map.current!.panBy([0, 140], { animate: false })
    })

    await user.hover(marker('AA 3-20212'))
    expect(await screen.findByRole('tooltip')).toHaveClass('leaflet-tooltip-bottom')
    await user.unhover(marker('AA 3-20212'))
    await user.hover(marker('AA 3-12345'))
    expect(await screen.findByRole('tooltip')).toHaveClass('leaflet-tooltip-top')
  })
})
