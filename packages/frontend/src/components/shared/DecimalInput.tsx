import { useEffect, useId, useState } from 'react'
import { formatMinor, parseDecimal, type ParseError } from './decimal'

export interface DecimalInputProps {
  label: string
  /** Integer minor units, or null when empty or invalid. */
  value: number | null
  /** Called with integer minor units, or null when the field is empty or its text is invalid. Never a float. */
  onChange: (minor: number | null) => void
  name?: string
  required?: boolean
  disabled?: boolean
  /** Message from the form (for example a server-side validation error). */
  error?: string
}

interface Props extends DecimalInputProps {
  decimals: number
  unitLabel: string
  messages: Record<ParseError, string>
}

/**
 * What MoneyInput and FuelInput share. The field's state is the text the user
 * typed, never a number: the integer is produced by joining digit strings.
 * A valid value is emitted on every keystroke (so pressing Enter in a form
 * submits it, with no blur needed) and the text is tidied to a fixed number of
 * decimals on blur.
 */
export function DecimalInput({
  label,
  value,
  onChange,
  name,
  required,
  disabled,
  error,
  decimals,
  unitLabel,
  messages,
}: Props) {
  const id = useId()
  const [text, setText] = useState(() => (value === null ? '' : formatMinor(value, decimals, decimals, { group: false })))
  const [touched, setTouched] = useState(false)

  // The form changed the value (a reset, a loaded record): show it.
  useEffect(() => {
    const parsed = parseDecimal(text, decimals)
    const current = parsed.ok ? parsed.minor : null
    if (current !== value) setText(value === null ? '' : formatMinor(value, decimals, decimals, { group: false }))
    // `text` is deliberately not a dependency: typing must not be overwritten.
  }, [value, decimals])

  const parsed = parseDecimal(text, decimals)
  const inlineError = !parsed.ok
    ? messages[parsed.error]
    : parsed.minor === null && required && touched
      ? 'This field is required.'
      : undefined
  const shownError = inlineError ?? error

  function handleChange(next: string) {
    setText(next)
    const result = parseDecimal(next, decimals)
    onChange(result.ok ? result.minor : null)
  }

  function handleBlur() {
    setTouched(true)
    if (parsed.ok && parsed.minor !== null) {
      setText(formatMinor(parsed.minor, decimals, decimals, { group: false }))
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        required={required}
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={`${id}-hint ${id}-error`}
        className={`rounded border p-2 text-right tabular-nums ${shownError ? 'border-fms-danger' : 'border-slate-300'}`}
      />
      <p id={`${id}-hint`} className="text-xs text-slate-500">
        {unitLabel}
      </p>
      <p id={`${id}-error`} aria-live="polite" className="min-h-5 text-sm text-fms-danger">
        {shownError}
      </p>
    </div>
  )
}
