import { describe, expect, it } from 'vitest'
import { ago } from './ago'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const before = (ms: number) => new Date(NOW - ms).toISOString()
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('ago', () => {
  it('says "Just now" for the first minute, and for a clock that runs slightly behind', () => {
    expect(ago(before(0), NOW)).toBe('Just now')
    expect(ago(before(59 * SEC), NOW)).toBe('Just now')
    expect(ago(new Date(NOW + 30 * SEC).toISOString(), NOW)).toBe('Just now')
  })

  it('counts whole minutes, then hours, then days, rounding down', () => {
    expect(ago(before(60 * SEC), NOW)).toBe('1 min ago')
    expect(ago(before(59 * MIN + 59 * SEC), NOW)).toBe('59 min ago')
    expect(ago(before(HOUR), NOW)).toBe('1 h ago')
    expect(ago(before(23 * HOUR + 59 * MIN), NOW)).toBe('23 h ago')
    expect(ago(before(DAY), NOW)).toBe('1 d ago')
    expect(ago(before(6 * DAY + 23 * HOUR), NOW)).toBe('6 d ago')
  })

  it('gives a date from a week on, as the Addis Ababa day', () => {
    expect(ago(before(7 * DAY), NOW)).toBe('16 Oct')
    expect(ago(before(29 * DAY), NOW)).toBe('24 Sept')
    // 21:30 UTC is already the next day in Addis Ababa.
    expect(ago('2026-10-01T21:30:00Z', NOW)).toBe('2 Oct')
  })

  it('is empty for something that is not a date', () => {
    expect(ago('yesterday', NOW)).toBe('')
    expect(ago('', NOW)).toBe('')
  })
})
