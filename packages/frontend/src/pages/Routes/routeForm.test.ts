import { describe, expect, it } from 'vitest'
import type { Route } from './api'
import { EMPTY_FORM, changedFields, formField, formFromRoute, formatDistance, formatDuration, newStop, parseCoordinates, validateRouteForm } from './routeForm'

const base: Route = {
  id: 'r-1',
  name: 'Addis Ababa - Adama',
  depot_id: 'd-1',
  origin_name: 'Addis Ababa',
  origin: { latitude: 9.0054, longitude: 38.7636 },
  destination_name: 'Adama',
  destination: null,
  stops: [{ name: 'Bishoftu', latitude: 8.75, longitude: 38.98 }],
  distance_km: 99.5,
  estimated_duration_seconds: 9000,
  distance_source: 'manual',
  measured_at: null,
  is_active: true,
  version: 1,
  updated_at: '2026-10-10T08:00:00Z',
}

describe('parseCoordinates', () => {
  it('reads "lat, lng" as a map app copies it, with a comma, spaces or both', () => {
    expect(parseCoordinates('9.0054, 38.7636')).toEqual({ ok: true, value: { latitude: 9.0054, longitude: 38.7636 } })
    expect(parseCoordinates(' 9.0054 38.7636 ')).toEqual({ ok: true, value: { latitude: 9.0054, longitude: 38.7636 } })
    expect(parseCoordinates('-33.9,18.4')).toEqual({ ok: true, value: { latitude: -33.9, longitude: 18.4 } })
    expect(parseCoordinates('')).toEqual({ ok: true, value: null })
  })

  it('refuses half a point, words, out-of-range values and more than 6 decimals', () => {
    expect(parseCoordinates('9.0054')).toMatchObject({ ok: false })
    expect(parseCoordinates('Addis Ababa')).toMatchObject({ ok: false })
    expect(parseCoordinates('91, 38')).toEqual({ ok: false, error: 'Latitude is between -90 and 90.' })
    expect(parseCoordinates('9, 181')).toEqual({ ok: false, error: 'Longitude is between -180 and 180.' })
    expect(parseCoordinates('9.1234567, 38')).toEqual({ ok: false, error: 'At most 6 decimals (about 10 cm).' })
  })
})

describe('validateRouteForm', () => {
  it('needs a name and a depot; everything else is optional', () => {
    expect(validateRouteForm(EMPTY_FORM).errors).toEqual({ name: 'Give the route a name.', depot_id: 'Choose the depot this route belongs to.' })
    expect(validateRouteForm({ ...EMPTY_FORM, name: ' Short hop ', depot_id: 'd-1' }).input).toEqual({
      name: 'Short hop',
      depot_id: 'd-1',
      origin_name: null,
      origin: null,
      destination_name: null,
      destination: null,
      stops: [],
      distance_km: null,
      estimated_duration_seconds: null,
    })
  })

  it('drops blank stop rows, names a stop without a name, and keys errors by row', () => {
    const values = { ...EMPTY_FORM, name: 'X', depot_id: 'd-1', stops: [newStop(), { ...newStop(), coordinates: '8.6, 39' }, { ...newStop(), name: 'Mojo', coordinates: 'x' }] }
    expect(validateRouteForm(values).errors).toEqual({ 'stops.1.name': 'Name the stop.', 'stops.2.coordinates': 'Latitude, then longitude, e.g. 9.0054, 38.7636.' })
    const ok = validateRouteForm({ ...values, stops: [newStop(), { ...newStop(), name: 'Mojo', coordinates: '8.6, 39' }] })
    expect(ok.input?.stops).toEqual([{ name: 'Mojo', latitude: 8.6, longitude: 39 }])
  })

  it('reads distance in km (3 decimals) and time as hours plus minutes', () => {
    const values = { ...EMPTY_FORM, name: 'X', depot_id: 'd-1' }
    expect(validateRouteForm({ ...values, distance_km: '12.3456' }).errors.distance_km).toBe('Kilometres, with at most 3 decimals.')
    expect(validateRouteForm({ ...values, minutes: '75' }).errors.minutes).toBe('Whole minutes, 0 to 59.')
    expect(validateRouteForm({ ...values, distance_km: '12.345', hours: '1', minutes: '' }).input).toMatchObject({ distance_km: 12.345, estimated_duration_seconds: 3600 })
    expect(validateRouteForm({ ...values, minutes: '45' }).input?.estimated_duration_seconds).toBe(2700)
  })
})

describe('changedFields', () => {
  it('a route loaded into the form and saved unchanged sends nothing', () => {
    const { input } = validateRouteForm(formFromRoute(base))
    expect(changedFields(input!, base)).toEqual({})
  })

  it('sends only the fields that differ, whatever key order the server used', () => {
    const fromServer = { ...base, stops: [{ longitude: 38.98, name: 'Bishoftu', latitude: 8.75 }] } as Route
    const { input } = validateRouteForm({ ...formFromRoute(fromServer), distance_km: '101' })
    expect(changedFields(input!, fromServer)).toEqual({ distance_km: 101 })
  })

  it("a road's time, to the second, shown in whole minutes, is unchanged until the minutes change (FMS-84)", () => {
    const measured: Route = { ...base, distance_km: 91, estimated_duration_seconds: 4613, distance_source: 'road', measured_at: '2026-10-30T09:00:00Z' }
    const form = formFromRoute(measured)
    expect(changedFields(validateRouteForm(form).input!, measured)).toEqual({})
    expect(changedFields(validateRouteForm({ ...form, destination: '8.5408, 39.2716' }).input!, measured)).toEqual({ destination: { latitude: 8.5408, longitude: 39.2716 } })
    expect(changedFields(validateRouteForm({ ...form, minutes: '20' }).input!, measured)).toEqual({ estimated_duration_seconds: 4800 })
  })
})

describe('formField', () => {
  it('maps API error fields onto the form', () => {
    expect(formField('origin.latitude')).toBe('origin')
    expect(formField('stops.2')).toBe('stops.2.coordinates')
    expect(formField('stops')).toBe('stops')
    expect(formField('estimated_duration_seconds')).toBe('hours')
    expect(formField('depot_id')).toBe('depot_id')
    expect(formField('geometry')).toBeUndefined()
  })
})

describe('display', () => {
  it('formats time and distance, with a dash when unknown', () => {
    expect(formatDuration(9000)).toBe('2 h 30 min')
    expect(formatDuration(7200)).toBe('2 h')
    expect(formatDuration(2700)).toBe('45 min')
    expect(formatDuration(null)).toBe('—')
    expect(formatDistance(1234.5)).toBe('1,234.5 km')
    expect(formatDistance(null)).toBe('—')
  })
})
