// Text <-> integer minor units, with no floating point anywhere. "149.99"
// becomes 14999 by joining digit strings, because 1.005 * 100 is 100.49999...
// in a double and a multiplication would silently store the wrong amount.

export type ParseError = 'format' | 'too_many_decimals' | 'too_large'

export type ParseResult = { ok: true; minor: number | null } | { ok: false; error: ParseError }

const DECIMAL = /^(\d*)(?:\.(\d*))?$/

/** 12 whole digits plus 3 decimals stay below Number.MAX_SAFE_INTEGER (about 9.007e15). */
const MAX_WHOLE_DIGITS = 12

/**
 * Parses what a user typed. Empty input is `null` (nothing entered). Trailing
 * zeros past the precision are harmless ("149.990"); any other extra digit is
 * rejected rather than rounded, so a typo never changes an amount unnoticed.
 */
export function parseDecimal(text: string, decimals: number): ParseResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, minor: null }

  const match = DECIMAL.exec(trimmed)
  const whole = match?.[1] ?? ''
  const fraction = match?.[2] ?? ''
  if (!match || (whole === '' && fraction === '')) return { ok: false, error: 'format' }

  if (fraction.replace(/0+$/, '').length > decimals) return { ok: false, error: 'too_many_decimals' }
  if (whole.replace(/^0+/, '').length > MAX_WHOLE_DIGITS) return { ok: false, error: 'too_large' }

  const digits = (whole || '0') + fraction.slice(0, decimals).padEnd(decimals, '0')
  return { ok: true, minor: Number.parseInt(digits, 10) }
}

/**
 * Integer minor units as text: `formatMinor(14999, 2)` is "149.99" and
 * `formatMinor(123456789, 2)` is "1,234,567.89". `shownDecimals` below
 * `storedDecimals` rounds half away
 * from zero using integer arithmetic ((23505 ml, 3, 2) is "23.51"; a float
 * `toFixed` would give "23.50").
 */
export function formatMinor(
  minor: number,
  storedDecimals: number,
  shownDecimals: number = storedDecimals,
  options: { group?: boolean } = {},
): string {
  const { group = true } = options
  const negative = minor < 0
  let abs = Math.abs(minor)

  if (shownDecimals < storedDecimals) {
    const step = 10 ** (storedDecimals - shownDecimals)
    const kept = Math.trunc(abs / step)
    abs = (abs % step) * 2 >= step ? kept + 1 : kept
  } else if (shownDecimals > storedDecimals) {
    abs *= 10 ** (shownDecimals - storedDecimals)
  }

  const digits = String(abs).padStart(shownDecimals + 1, '0')
  const whole = digits.slice(0, digits.length - shownDecimals)
  const fraction = digits.slice(digits.length - shownDecimals)
  const grouped = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole

  const sign = negative && abs !== 0 ? '-' : ''
  return `${sign}${grouped}${shownDecimals > 0 ? `.${fraction}` : ''}`
}
