import { afterEach, describe, expect, it } from 'vitest'
import { setPreference } from '@/lib/preferences'
import { formatDate } from './expiry'

afterEach(() => setPreference('fms-calendar', 'gregorian'))

describe('formatDate', () => {
  it('shows the Gregorian date by default, without time-zone shifts', () => {
    expect(formatDate('2027-03-12')).toBe('12 Mar 2027')
  })

  it('shows the same day on the Ethiopian calendar when chosen', () => {
    setPreference('fms-calendar', 'ethiopic')
    // 12 March 2027 is 3 Megabit 2019 (Ethiopian year), before the new year in September.
    const text = formatDate('2027-03-12')
    expect(text).toMatch(/2019/)
    expect(text).not.toBe('12 Mar 2027')
  })
})
