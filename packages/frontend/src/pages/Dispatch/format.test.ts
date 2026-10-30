import { describe, expect, it } from 'vitest'
import { formatDuration, fromAddisInput, nextQuarterHour, toAddisInput } from './format'

describe('times typed in Addis Ababa (FMS-139)', () => {
  it('reads and writes datetime-local values at UTC+3, whatever the browser zone', () => {
    expect(toAddisInput('2026-11-02T06:00:00Z')).toBe('2026-11-02T09:00')
    expect(toAddisInput('2026-11-02T22:30:00Z')).toBe('2026-11-03T01:30')
    expect(fromAddisInput('2026-11-03T01:30')).toBe('2026-11-02T22:30:00.000Z')
  })

  it('a blank or half-typed value is no time at all', () => {
    expect(fromAddisInput('')).toBeNull()
    expect(fromAddisInput('2026-11-02')).toBeNull()
    expect(fromAddisInput('2026-13-02T09:00')).toBeNull()
  })

  it('a new trip starts at the next quarter hour', () => {
    expect(nextQuarterHour(new Date('2026-11-02T06:07:30Z'))).toBe('2026-11-02T06:15:00.000Z')
    expect(nextQuarterHour(new Date('2026-11-02T06:15:00Z'))).toBe('2026-11-02T06:30:00.000Z')
  })

  it('durations read as hours and minutes', () => {
    expect(formatDuration(5400)).toBe('1 h 30 min')
    expect(formatDuration(2700)).toBe('45 min')
    expect(formatDuration(7200)).toBe('2 h')
  })
})
