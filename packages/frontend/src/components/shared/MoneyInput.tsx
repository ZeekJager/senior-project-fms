import { DecimalInput, type DecimalInputProps } from './DecimalInput'

const MESSAGES = {
  format: 'Enter an amount like 149.99.',
  too_many_decimals: 'Use at most 2 decimal places.',
  too_large: 'That amount is too large.',
}

/** A money field. `value`/`onChange` are integer Ethiopian cents: typing "149.99" emits 14999. */
export function MoneyInput(props: DecimalInputProps) {
  return <DecimalInput {...props} decimals={2} unitLabel="ETB, up to 2 decimal places" messages={MESSAGES} />
}
