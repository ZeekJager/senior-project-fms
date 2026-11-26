import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { StationLayer, stationSpec, type MapStation } from '.'

// FMS-99: the charging stations on a map. jsdom has no SVG layout, so the map's layers are stand-ins that render
// their class and their tooltip's text (as in TripMap's test).
type Layer = { pathOptions?: { className?: string }; radius?: number; children?: ReactNode }
vi.mock('react-leaflet', () => ({
  CircleMarker: ({ pathOptions, radius, children }: Layer) => (
    <i data-layer={pathOptions?.className} data-radius={radius}>
      {children}
    </i>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

const station = (id: string, extra: Partial<MapStation> = {}): MapStation => ({ id, name: `Station ${id}`, latitude: 9.0, longitude: 38.76, power_kw: 60, connector_type: 'CCS2', status: 'available', ...extra })

describe('StationLayer (FMS-99)', () => {
  it('draws each station with a place: filled where an EV charges now, dashed out of service, none without a place', () => {
    const { container } = render(
      <StationLayer stations={[station('a'), station('b'), station('c', { status: 'offline' }), station('d', { latitude: null })]} chargingAt={new Map([['a', 2]])} />,
    )
    const layers = [...container.querySelectorAll<HTMLElement>('[data-layer]')].map((el) => el.dataset.layer)
    expect(layers).toEqual(['station-dot station-dot--busy', 'station-dot', 'station-dot station-dot--down'])
    expect(screen.getByText(/2 charging now/)).toBeInTheDocument()
    expect(screen.getByText(/Free/)).toBeInTheDocument()
    expect(screen.getByText(/Out of service/)).toBeInTheDocument()
    expect(screen.queryByText('Station d')).not.toBeInTheDocument()
  })

  it('says what a station offers', () => {
    expect(stationSpec({ power_kw: 60, connector_type: 'CCS2' })).toBe('60 kW · CCS2')
    expect(stationSpec({ power_kw: null, connector_type: 'Type 2' })).toBe('Type 2')
    expect(stationSpec({ power_kw: null, connector_type: null })).toBe('')
  })
})
