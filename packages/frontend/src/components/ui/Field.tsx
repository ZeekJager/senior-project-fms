import { AlertCircle, ChevronDown } from 'lucide-react'
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cn } from './cn'

// Floating-label fields. The label sits inside the control like a placeholder
// and moves up once the field has focus or a value; it is a real <label>, so
// it is the accessible name in both positions. A message line under every
// field is always rendered: a live region must exist before its text changes
// to be announced.

const CONTROL =
  'peer block h-14 w-full rounded-control border bg-surface px-4 pb-1.5 pt-[22px] text-sm text-ink shadow-soft ' +
  'transition-[border-color,box-shadow,background-color] duration-150 ease-smooth placeholder:text-transparent ' +
  'hover:border-ink-subtle/50 focus:outline-none focus:ring-4 disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle'

const controlState = (invalid: boolean) =>
  invalid ? 'border-danger/70 focus:border-danger focus:ring-danger/15' : 'border-line-strong focus:border-brand focus:ring-brand/15'

// Resting: centred like a placeholder. Floating: small, at the top.
const LABEL =
  'pointer-events-none absolute left-4 top-1/2 origin-left -translate-y-1/2 select-none text-sm text-ink-subtle ' +
  'transition-all duration-150 ease-smooth ' +
  'peer-focus:top-[15px] peer-focus:text-xs peer-focus:font-medium peer-focus:text-brand-ink ' +
  'peer-[:not(:placeholder-shown)]:top-[15px] peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:font-medium'

const FLOATED_LABEL =
  'pointer-events-none absolute left-4 top-[15px] -translate-y-1/2 select-none text-xs font-medium text-ink-subtle'

interface FieldChromeProps {
  id: string
  label: string
  error?: string | null
  hint?: ReactNode
  optional?: boolean
}

function labelText(label: string, optional?: boolean) {
  return (
    <>
      {label}
      {optional && <span className="font-normal text-ink-subtle"> (optional)</span>}
    </>
  )
}

function Message({ id, error, hint }: { id: string; error?: string | null; hint?: ReactNode }) {
  return (
    <p id={id} aria-live="polite" className={cn('mt-1.5 flex min-h-5 items-start gap-1.5 px-1 text-xs', error ? 'text-danger' : 'text-ink-subtle')}>
      {error ? (
        <>
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </>
      ) : (
        hint
      )}
    </p>
  )
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'placeholder'>, Omit<FieldChromeProps, 'id'> {
  /** Content at the right end of the control: a unit, a status icon. */
  trailing?: ReactNode
  /** Keep the label at the top even when empty (date inputs always show their own pattern). */
  alwaysFloat?: boolean
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, optional, trailing, alwaysFloat, id: idProp, className, ...rest },
  ref,
) {
  const generated = useId()
  const id = idProp ?? generated
  const messageId = `${id}-message`
  return (
    <div className={className}>
      <div className="relative">
        <input
          ref={ref}
          id={id}
          // A placeholder is needed for :placeholder-shown, which floats the label; it is invisible.
          placeholder=" "
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          className={cn(CONTROL, controlState(!!error), trailing ? 'pr-12' : undefined)}
          {...rest}
        />
        <label htmlFor={id} className={alwaysFloat ? FLOATED_LABEL : LABEL}>
          {labelText(label, optional)}
        </label>
        {trailing && <div className="absolute inset-y-0 right-4 flex items-center text-ink-subtle">{trailing}</div>}
      </div>
      <Message id={messageId} error={error} hint={hint} />
    </div>
  )
})

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement>, Omit<FieldChromeProps, 'id'> {
  options: readonly { value: string; label: string }[]
  /** Text of the empty first option; omit when a value is always chosen. */
  placeholder?: string
}

/** A native select (reliable keyboard and screen-reader support) dressed as a floating-label field. */
export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, error, hint, optional, options, placeholder, id: idProp, className, ...rest },
  ref,
) {
  const generated = useId()
  const id = idProp ?? generated
  const messageId = `${id}-message`
  return (
    <div className={className}>
      <div className="relative">
        <select
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          data-empty={rest.value === '' || undefined}
          className={cn(CONTROL, controlState(!!error), 'cursor-pointer appearance-none pr-10 data-[empty]:text-ink-subtle')}
          {...rest}
        >
          {placeholder !== undefined && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label htmlFor={id} className={FLOATED_LABEL}>
          {labelText(label, optional)}
        </label>
        <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
      </div>
      <Message id={messageId} error={error} hint={hint} />
    </div>
  )
})
