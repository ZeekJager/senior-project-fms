import { DecimalInput, type DecimalInputProps } from './DecimalInput'

const MESSAGES = {
  format: 'Enter a reading like 123456 or 123456.7.',
  negative: 'A reading cannot be negative.',
  too_many_decimals: 'Use at most 1 decimal place.',
  too_large: 'That reading is too large.',
}

/** An odometer reading in kilometres. `value`/`onChange` are integer tenths of a km: typing "123456.7" emits 1234567. */
export function OdometerInput(props: DecimalInputProps) {
  return <DecimalInput {...props} decimals={1} unitLabel="Kilometres, as on the odometer" unitShort="km" messages={MESSAGES} />
}
