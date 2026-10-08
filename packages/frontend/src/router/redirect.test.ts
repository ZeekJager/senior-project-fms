import { describe, expect, it } from 'vitest'
import { homePathFor, loginPathFor, safeRedirect } from './redirect'

describe('loginPathFor', () => {
  it('keeps slashes readable', () => {
    expect(loginPathFor('/dashboard')).toBe('/login?redirect=/dashboard')
  })

  it('escapes characters that would end the redirect value', () => {
    expect(loginPathFor('/a?x=1&y=2#top')).toBe('/login?redirect=/a%3Fx%3D1%26y%3D2%23top')
  })
})

describe('safeRedirect', () => {
  it('accepts in-app paths, with query', () => {
    expect(safeRedirect('/vehicles?page=2', '/dashboard')).toBe('/vehicles?page=2')
  })

  it.each([null, undefined, '', 'dashboard', 'https://evil.example', '//evil.example', '/\\evil.example', '/login', '/login?x=1'])(
    'falls back for %s',
    (raw) => {
      expect(safeRedirect(raw, '/dashboard')).toBe('/dashboard')
    },
  )
})

describe('homePathFor', () => {
  it('sends drivers to the driver portal and everyone else to the dashboard', () => {
    expect(homePathFor(['driver'])).toBe('/driver')
    expect(homePathFor(['dispatcher'])).toBe('/dashboard')
    expect(homePathFor([])).toBe('/dashboard')
  })
})
