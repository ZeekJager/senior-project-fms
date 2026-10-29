import { describe, expect, it } from 'vitest'
import permissionMatrix from '../../../../docs/permissions.md?raw'
import { homePathFor, isDriverPortalUser, navSections, type Viewer } from './navigation'

/**
 * Each role's permissions as seeded (docs/permissions.md is generated from
 * the database grants), so these menus are the ones real users get.
 */
function seededRoles(): Map<string, string[]> {
  const lines = permissionMatrix.split(/\r?\n/).filter((l) => l.startsWith('|'))
  const roles = lines[0].split('|').slice(2, -1).map((r) => r.trim())
  const grants = new Map(roles.map((r) => [r, [] as string[]]))
  for (const line of lines.slice(2)) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    const code = cells[0].replace(/`/g, '')
    roles.forEach((role, i) => cells[i + 1] === 'x' && grants.get(role)!.push(code))
  }
  return grants
}

const grants = seededRoles()
const viewer = (role: string): Viewer => ({ roles: [role], permissions: grants.get(role)! })
const menu = (role: string) => Object.fromEntries(navSections(viewer(role)).map((s) => [s.portal.name, s.routes.map((r) => r.nav!.label)]))

const FLEET_ALL = ['Dashboard', 'Vehicles', 'Drivers', 'Attendance', 'Repair log', 'Vehicle health', 'Spare parts', 'Routes', 'Fuel reconciliation']

describe('menus per role (seeded grants)', () => {
  it('reads all nine roles from the permission matrix', () => {
    expect([...grants.keys()].sort()).toEqual(
      ['admin', 'compliance_officer', 'depot_admin', 'dispatcher', 'driver', 'finance_clerk', 'fleet_manager', 'fleet_owner', 'technician'].sort(),
    )
  })

  it.each([
    ['admin', { 'Fleet management': FLEET_ALL, 'Command center': ['Dispatch', 'Live map'], Administration: ['Users & roles', 'Audit log'] }],
    ['fleet_manager', { 'Fleet management': FLEET_ALL, 'Command center': ['Dispatch', 'Live map'], Administration: ['Users & roles'] }],
    ['dispatcher', { 'Fleet management': ['Dashboard', 'Vehicles', 'Drivers', 'Attendance', 'Routes'], 'Command center': ['Dispatch', 'Live map'] }],
    ['depot_admin', { 'Fleet management': FLEET_ALL, 'Command center': ['Live map'] }],
    ['technician', { 'Fleet management': ['Dashboard', 'Vehicles', 'Repair log', 'Vehicle health', 'Spare parts'] }],
    ['finance_clerk', { 'Fleet management': ['Dashboard', 'Fuel reconciliation'] }],
    [
      'compliance_officer',
      { 'Fleet management': ['Dashboard', 'Vehicles', 'Drivers', 'Attendance', 'Repair log', 'Vehicle health', 'Routes', 'Fuel reconciliation'], Administration: ['Users & roles', 'Audit log'] },
    ],
    ['fleet_owner', { 'Fleet management': ['Dashboard', 'Vehicles', 'Drivers', 'Repair log', 'Vehicle health', 'Routes'], 'Command center': ['Live map'], Administration: ['Audit log'] }],
    ['driver', { Driver: ['My day', 'Inspection', 'Fuel', 'Incident'] }],
  ])('%s sees exactly the screens its permissions open', (role, expected) => {
    expect(menu(role)).toEqual(expected)
  })

  it('only drivers get the driver portal; staff who dispatch (trip:execute) do not', () => {
    expect([...grants.keys()].filter((r) => isDriverPortalUser(viewer(r)))).toEqual(['driver'])
  })
})

describe('home per role', () => {
  it('a driver lands on /driver, a dispatcher on /dispatch', () => {
    expect(homePathFor(viewer('driver'))).toBe('/driver')
    expect(homePathFor(viewer('dispatcher'))).toBe('/dispatch')
  })

  it.each([
    ['admin', '/dashboard'],
    ['fleet_manager', '/dashboard'],
    ['fleet_owner', '/dashboard'],
    ['depot_admin', '/dashboard'],
    ['compliance_officer', '/dashboard'],
    ['technician', '/maintenance'],
    ['finance_clerk', '/fuel-reconciliation'],
  ])('%s lands on %s', (role, path) => {
    expect(homePathFor(viewer(role))).toBe(path)
  })

  it('every home is in its own menu: no one lands on a screen they cannot open', () => {
    for (const role of grants.keys()) {
      const links = navSections(viewer(role)).flatMap((s) => s.routes.map((r) => r.path))
      expect(links, role).toContain(homePathFor(viewer(role)))
    }
  })

  it('a role whose home it cannot open goes to its first menu link; several roles take the most specific', () => {
    expect(homePathFor({ roles: ['dispatcher'], permissions: ['driver:read'] })).toBe('/dashboard')
    expect(homePathFor({ roles: ['driver', 'dispatcher'], permissions: grants.get('dispatcher')! })).toBe('/dispatch')
    expect(homePathFor({ roles: [], permissions: [] })).toBe('/dashboard')
  })
})
