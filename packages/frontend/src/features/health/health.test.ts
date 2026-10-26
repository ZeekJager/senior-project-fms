import { describe, expect, it } from 'vitest'
import { bandOf, featureLabel, formatAge, formatFactorValue, healthViewOf, isStale } from './health'

const NOW = Date.parse('2026-10-26T09:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

describe('health score bands (FMS-56)', () => {
  it('colours below 75 at risk, 75 to 84 watch, 85 and up healthy', () => {
    expect([0, 60, 74, 75, 84, 85, 100].map(bandOf)).toEqual(['at_risk', 'at_risk', 'at_risk', 'watch', 'watch', 'healthy', 'healthy'])
  })

  it('a score more than 25 hours old is stale whatever its value; none is unscored', () => {
    expect(isStale(hoursAgo(25), NOW)).toBe(false)
    expect(isStale(hoursAgo(25.1), NOW)).toBe(true)
    expect(healthViewOf(40, hoursAgo(30), NOW)).toBe('stale')
    expect(healthViewOf(60, hoursAgo(2), NOW)).toBe('at_risk')
    expect(healthViewOf(null, null, NOW)).toBe('unscored')
  })
})

describe('factors in words', () => {
  it('names each input and gives its value with its unit', () => {
    expect(featureLabel('days_since_last_service')).toBe('Time since last service')
    expect(featureLabel('a_new_input')).toBe('A new input')
    expect(formatFactorValue(100, 'd')).toBe('100 days')
    expect(formatFactorValue(1, 'd')).toBe('1 day')
    expect(formatFactorValue(17380.5, 'km')).toBe('17,381 km')
    expect(formatFactorValue(3.1, '%')).toBe('+3.1%')
    expect(formatFactorValue(-4, '%')).toBe('-4%')
    expect(formatFactorValue(7.94, 'years')).toBe('7.9 years')
    expect(formatFactorValue(5, 'count')).toBe('5')
    expect(formatFactorValue(null, 'km')).toBe('—')
  })

  it('says how old a score is', () => {
    expect(formatAge(hoursAgo(0.5), NOW)).toBe('just now')
    expect(formatAge(hoursAgo(7), NOW)).toBe('7 h ago')
    expect(formatAge(hoursAgo(50), NOW)).toBe('2 days ago')
  })
})
