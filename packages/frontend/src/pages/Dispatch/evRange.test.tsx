import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { rangeShort, warningText } from './AssignmentPanel'
import { VehicleList } from './Candidates'
import type { AvailabilityResult, BoardVehicle } from './types'

// FMS-98: the dispatch console shows each EV's range, amber when it is short of the trip being staffed, and the
// assignment's EV_RANGE_SHORT warning reads as what it means.

const free: AvailabilityResult = { availability: 'available', reasons: [] }

function vehicle(overrides: Partial<BoardVehicle> = {}): BoardVehicle {
  return {
    vehicle_id: 'v-1',
    registration_number: 'AA 3-20001',
    make: 'BYD',
    model: 'T3',
    vehicle_type: 'van',
    status: 'active',
    state: 'idle',
    availability: free,
    open_work: null,
    service_due: null,
    current_trip: null,
    ...overrides,
  }
}

const range = { range_km: 120, state_of_charge: 30, recorded_at: '2026-11-26T08:00:00Z', wh_per_km: 250 }

describe('EV range on the dispatch console', () => {
  it('shows an EV’s range and charge on its card', () => {
    render(<VehicleList vehicles={[vehicle({ ev_range: range })]} selectedId={null} onSelect={() => {}} tripKm={90} />)
    expect(screen.getByText(/Range about 120 km · 30%/)).toBeInTheDocument()
    expect(screen.queryByText(/short of the/)).not.toBeInTheDocument()
  })

  it('says when the range is short of the trip being staffed', () => {
    render(<VehicleList vehicles={[vehicle({ ev_range: range })]} selectedId={null} onSelect={() => {}} tripKm={180} />)
    const line = screen.getByText(/Range about 120 km/)
    expect(line).toHaveTextContent('short of the 180 km trip')
    expect(line.className).toContain('text-warning')
  })

  it('shows no range for a vehicle without one', () => {
    render(<VehicleList vehicles={[vehicle({ vehicle_type: 'truck', make: 'Isuzu', model: 'FSR', ev_range: null })]} selectedId={null} onSelect={() => {}} tripKm={180} />)
    expect(screen.queryByText(/Range about/)).not.toBeInTheDocument()
  })

  it('rangeShort: only an EV with an estimate below a known trip distance', () => {
    expect(rangeShort(vehicle({ ev_range: range }), 180)).toBe(true)
    expect(rangeShort(vehicle({ ev_range: range }), 100)).toBe(false)
    expect(rangeShort(vehicle({ ev_range: range }), null)).toBe(false)
    expect(rangeShort(vehicle(), 180)).toBe(false)
  })

  it('the assignment’s range warning reads as what it means', () => {
    expect(warningText({ warning: 'EV_RANGE_SHORT', field: 'vehicle_id', range_km: 120, trip_km: 180, state_of_charge: 30 }, null)).toBe(
      'The vehicle has about 120 km of charge (30%) for a 180 km trip: plan a charge before it leaves.',
    )
  })
})
