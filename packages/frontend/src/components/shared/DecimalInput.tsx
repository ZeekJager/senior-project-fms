import { AlertCircle } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { cn } from '@/components/ui'
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
  /** Extra guidance under the field, after the unit (e.g. "Parts so far: ETB 192.00"). */
  hint?: ReactNode
  /** Keep the label for screen readers only (compact rows with column headers). */
  hideLabel?: boolean
  className?: string
}

interface Props extends DecimalInputProps {
  decimals: number
  unitLabel: string
  /** Shown inside the field, at its right end ("ETB", "L"). */
  unitShort: string
  messages: Record<ParseError, string>
}

/**
 * What MoneyInput and FuelInput share. The field's state is the text the user
 * typed, never a number: the integer is produced by joining digit strings.
 * A valid value is emitted on every keystroke (so pressing Enter in a form
 * submits it, with no blur needed) and the text is tidied to a fixed number of
 * decimals on blur. Styled as the design system's floating-label field.
 */
export function DecimalInput({
  label,
  value,
  onChange,
  name,
  required,
  disabled,
  error,
  hint,
  hideLabel,
  className,
  decimals,
  unitLabel,
  unitShort,
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
    <div className={className}>
      <div className="relative">
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
          className={cn(
            'tabular block w-full rounded-control border bg-surface pr-12 text-right text-sm text-ink shadow-soft',
            'transition-[border-color,box-shadow] duration-150 ease-smooth hover:border-ink-subtle/50 focus:outline-none focus:ring-4',
            'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle',
            hideLabel ? 'h-10 pl-3' : 'h-14 pb-1.5 pl-4 pt-[22px]',
            shownError ? 'border-danger/70 focus:border-danger focus:ring-danger/15' : 'border-line-strong focus:border-brand focus:ring-brand/15',
          )}
        />
        <label
          htmlFor={id}
          className={cn(
            hideLabel ? 'sr-only' : 'pointer-events-none absolute left-4 top-[15px] -translate-y-1/2 select-none text-xs font-medium text-ink-subtle',
          )}
        >
          {label}
        </label>
        <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-xs text-ink-subtle" aria-hidden="true">
          {unitShort}
        </span>
      </div>
      <p id={`${id}-hint`} className={cn('mt-1.5 px-1 text-xs text-ink-subtle', (shownError || hideLabel) && 'sr-only')}>
        {unitLabel}
        {hint && <span className="text-ink-muted"> · {hint}</span>}
      </p>
      <p id={`${id}-error`} aria-live="polite" className={cn('flex items-start gap-1.5 px-1 text-xs text-danger', shownError ? 'mt-1.5 min-h-5' : 'min-h-0')}>
        {shownError && (
          <>
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {shownError}
          </>
        )}
      </p>
    </div>
  )
}
