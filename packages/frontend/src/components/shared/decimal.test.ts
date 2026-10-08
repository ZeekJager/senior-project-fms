import { describe, expect, it } from 'vitest'
import { formatMinor, parseDecimal } from './decimal'

const minor = (text: string, decimals: number) => {
  const r = parseDecimal(text, decimals)
  return r.ok ? r.minor : r.error
}

describe('parseDecimal (money, 2 decimals)', () => {
  it.each([
    ['149.99', 14999],
    ['149.9', 14990],
    ['149', 14900],
    ['0.01', 1],
    ['.5', 50],
    ['5.', 500],
    ['  12.30  ', 1230],
    ['007.10', 710],
    ['149.990', 14999], // a trailing zero past the precision changes nothing
    ['', null],
    ['   ', null],
  ])('%j -> %j', (text, expected) => {
    expect(minor(text, 2)).toBe(expected)
  })

  it('rejects a third decimal instead of rounding it', () => {
    expect(minor('149.999', 2)).toBe('too_many_decimals')
    // 1.005 * 100 is 100.49999999999999 in a double: a multiplying parser would store 100.
    expect(minor('1.005', 2)).toBe('too_many_decimals')
    expect(minor('0.001', 2)).toBe('too_many_decimals')
  })

  it.each(['abc', '1e3', '-5', '+5', '1,5', '1.2.3', '.', '12 34', '١٢'])('rejects %j as a bad format', (text) => {
    expect(minor(text, 2)).toBe('format')
  })

  it('avoids the classic float failure: 0.1 + 0.2 is exactly 0.3', () => {
    expect((minor('0.1', 2) as number) + (minor('0.2', 2) as number)).toBe(minor('0.3', 2))
  })

  it('rejects amounts that would exceed the safe integer range', () => {
    expect(minor('999999999999.99', 2)).toBe(99999999999999)
    expect(minor('1000000000000', 2)).toBe('too_large')
    expect(minor('99999999999999999999', 2)).toBe('too_large')
  })
})

describe('parseDecimal (fuel, 3 decimals)', () => {
  it.each([
    ['23.5', 23500],
    ['23.500', 23500],
    ['0.001', 1],
    ['0.1', 100],
  ])('%j -> %j', (text, expected) => {
    expect(minor(text, 3)).toBe(expected)
  })

  it('rejects a fourth decimal', () => {
    expect(minor('23.5001', 3)).toBe('too_many_decimals')
  })

  it('always yields an integer', () => {
    for (const text of ['0.1', '0.7', '1.1', '19.999', '4.35']) {
      expect(Number.isInteger(minor(text, 3))).toBe(true)
    }
  })
})

describe('formatMinor', () => {
  it.each([
    [14999, 2, 2, '149.99'],
    [0, 2, 2, '0.00'],
    [5, 2, 2, '0.05'],
    [100, 2, 2, '1.00'],
    [123456789, 2, 2, '1,234,567.89'],
    [-14999, 2, 2, '-149.99'],
    [23500, 3, 3, '23.500'],
    [23500, 3, 2, '23.50'],
    [1, 3, 3, '0.001'],
  ])('(%i, %i, %i) -> %s', (value, stored, shown, expected) => {
    expect(formatMinor(value, stored, shown)).toBe(expected)
  })

  it('rounds half away from zero with integers, where toFixed would not', () => {
    expect(formatMinor(23505, 3, 2)).toBe('23.51')
    expect(formatMinor(23504, 3, 2)).toBe('23.50')
    expect(formatMinor(-23505, 3, 2)).toBe('-23.51')
    expect(formatMinor(999999, 3, 2)).toBe('1,000.00')
    expect((23.505).toFixed(2)).toBe('23.50') // the float answer this avoids
  })

  it('does not print a minus sign for a value that rounds to zero', () => {
    expect(formatMinor(-4, 3, 2)).toBe('0.00')
  })

  it('can leave grouping off for text fields', () => {
    expect(formatMinor(123456789, 2, 2, { group: false })).toBe('1234567.89')
  })

  it('round-trips with parseDecimal', () => {
    for (const value of [0, 1, 99, 100, 14999, 123456789, 99999999999999]) {
      expect(minor(formatMinor(value, 2, 2, { group: false }), 2)).toBe(value)
    }
  })
})
