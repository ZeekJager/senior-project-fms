import { describe, expect, it } from 'vitest'
import { notificationLink } from './links'

const V = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const D = '3f2504e0-4f89-41d3-9a0c-0305e82c3302'
const E = '3f2504e0-4f89-41d3-9a0c-0305e82c3303'

const note = (type: string | null, extra: { vehicle_id?: string | null; driver_id?: string | null } = {}) => ({
  entity: type ? { type, id: E } : null,
  vehicle_id: extra.vehicle_id ?? null,
  driver_id: extra.driver_id ?? null,
})

// What each role can open, as the route table says (router/routes.tsx).
const everything = { permissions: ['vehicle:read', 'depot:read', 'driver:read', 'maintenance:read', 'fuel-anomaly:read', 'command:read', 'tracking:read', 'document:read'] }
const technician = { permissions: ['maintenance:read', 'vehicle:read'] }
const driverOnly = { permissions: ['trip:execute', 'vehicle:read'] }

describe('where a notification leads', () => {
  it('a vehicle fault opens maintenance narrowed to the vehicle; without the vehicle, maintenance', () => {
    expect(notificationLink(note('dvir_report', { vehicle_id: V }), technician)).toBe(`/maintenance?vehicle=${V}`)
    expect(notificationLink(note('dvir_report'), technician)).toBe('/maintenance')
    expect(notificationLink(note('maintenance_prediction', { vehicle_id: V }), technician)).toBe('/maintenance')
  })

  it('a document opens the vehicles or the drivers, by whose it is', () => {
    expect(notificationLink(note('document', { vehicle_id: V }), everything)).toBe('/vehicles')
    expect(notificationLink(note('document', { driver_id: D }), everything)).toBe('/drivers')
    expect(notificationLink(note('document'), everything)).toBe('/vehicles')
  })

  it('a licence opens the drivers; a fuel anomaly itself on fuel reconciliation; telemetry and incidents the live map', () => {
    expect(notificationLink(note('driver', { driver_id: D }), everything)).toBe('/drivers')
    expect(notificationLink(note('fuel_anomaly'), everything)).toBe(`/fuel-reconciliation?tab=anomalies&anomaly=${E}`)
    expect(notificationLink(note('telemetry_flag', { vehicle_id: V }), everything)).toBe('/command-center?view=attention')
    expect(notificationLink(note('incident'), everything)).toBe('/command-center?view=attention')
    expect(notificationLink(note('vehicle', { vehicle_id: V }), everything)).toBe('/vehicles')
  })

  it('goes nowhere when the notification is about nothing, or about something the app has no screen for', () => {
    expect(notificationLink(note(null), everything)).toBeNull()
    expect(notificationLink(note('something_new'), everything)).toBeNull()
  })

  it('goes nowhere when the viewer may not open the screen: no link beats a link to "not allowed"', () => {
    expect(notificationLink(note('dvir_report', { vehicle_id: V }), driverOnly)).toBeNull()
    expect(notificationLink(note('driver', { driver_id: D }), technician)).toBeNull()
    expect(notificationLink(note('fuel_anomaly'), technician)).toBeNull()
    expect(notificationLink(note('incident'), technician)).toBeNull()
    // And a viewer with no permissions at all.
    expect(notificationLink(note('vehicle'), { permissions: [] })).toBeNull()
  })

  it('puts the id in the address safely', () => {
    expect(notificationLink(note('dvir_report', { vehicle_id: 'a b&c=d' }), technician)).toBe('/maintenance?vehicle=a%20b%26c%3Dd')
  })
})
