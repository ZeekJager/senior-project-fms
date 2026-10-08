import { DecimalInput, type DecimalInputProps } from './DecimalInput'

const MESSAGES = {
  format: 'Enter a volume like 23.5.',
  too_many_decimals: 'Use at most 3 decimal places.',
  too_large: 'That volume is too large.',
}

/** A fuel volume field in litres. `value`/`onChange` are integer millilitres: typing "23.5" emits 23500. */
export function FuelInput(props: DecimalInputProps) {
  return <DecimalInput {...props} decimals={3} unitLabel="Litres, up to 3 decimal places" messages={MESSAGES} />
}
