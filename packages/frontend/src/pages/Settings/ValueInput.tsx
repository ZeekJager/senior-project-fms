import { Check } from 'lucide-react'
import { cn, SelectField, TextAreaField, TextField } from '@/components/ui'
import { formatDuration, parseDuration, type ParameterRules, type ParameterType } from '@/lib/parameterTypes'
import type { Draft } from './registry'

interface ValueInputProps {
  id: string
  label: string
  type: ParameterType
  rules: ParameterRules
  draft: Draft
  onChange: (draft: Draft) => void
  error?: string | null
  hint?: string
  /** A secret: typed hidden, and the current value is never shown. */
  secret?: boolean
  disabled?: boolean
}

/** The range a number takes, for the hint: "20 to 200 km/h". */
function rangeOf(rules: ParameterRules): string | null {
  const unit = rules.unit && rules.unit !== '×' ? (rules.unit === '%' ? '%' : ` ${rules.unit}`) : ''
  if (rules.min !== undefined && rules.max !== undefined) return `${rules.min} to ${rules.max}${unit}.`
  if (rules.min !== undefined) return `At least ${rules.min}${unit}.`
  if (rules.max !== undefined) return `At most ${rules.max}${unit}.`
  return null
}

/** An editor that fits the parameter's type: a number with its unit, a switch, a dropdown, ticked options, a duration in words, JSON. */
export function ValueInput({ id, label, type, rules, draft, onChange, error, hint, secret, disabled }: ValueInputProps) {
  const text = Array.isArray(draft) ? '' : draft
  if (type === 'boolean') {
    const on = text === 'true'
    return (
      <div>
        <button
          type="button"
          id={id}
          role="switch"
          aria-checked={on}
          disabled={disabled}
          onClick={() => onChange(on ? 'false' : 'true')}
          className="group flex w-full items-center justify-between gap-4 rounded-control border border-line-strong bg-surface px-4 py-3 text-left shadow-soft transition-colors hover:border-ink-subtle/50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span>
            <span className="block text-sm font-medium text-ink">{label}</span>
            <span className="block text-xs text-ink-subtle">{on ? 'On' : 'Off'}</span>
          </span>
          <span aria-hidden="true" className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ease-smooth', on ? 'bg-brand' : 'bg-line-strong')}>
            <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-soft transition-transform duration-200 ease-smooth', on ? 'translate-x-[22px]' : 'translate-x-0.5')} />
          </span>
        </button>
        {(error || hint) && <p className={cn('mt-1.5 text-xs', error ? 'text-danger' : 'text-ink-subtle')}>{error ?? hint}</p>}
      </div>
    )
  }
  if (type === 'dropdown') {
    return <SelectField id={id} label={label} value={text} onChange={(e) => onChange(e.target.value)} options={rules.options ?? []} error={error} hint={hint} disabled={disabled} />
  }
  if (type === 'multi_select') {
    const chosen = Array.isArray(draft) ? draft : []
    const limits = [rules.min_items !== undefined ? `at least ${rules.min_items}` : null, rules.max_items !== undefined ? `at most ${rules.max_items}` : null].filter(Boolean).join(', ')
    return (
      <fieldset aria-describedby={`${id}-message`} disabled={disabled}>
        <legend className="mb-2 text-sm font-medium text-ink">{label}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(rules.options ?? []).map((o) => {
            const checked = chosen.includes(o.value)
            return (
              <label
                key={o.value}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-control border px-3 py-2.5 text-sm transition-colors has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand/15',
                  checked ? 'border-brand/50 bg-brand-soft/60 text-ink' : 'border-line-strong bg-surface text-ink hover:border-ink-subtle/50',
                )}
              >
                <input type="checkbox" className="sr-only" checked={checked} onChange={() => onChange(checked ? chosen.filter((v) => v !== o.value) : [...chosen, o.value])} />
                <span aria-hidden="true" className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface')}>
                  {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                {o.label}
              </label>
            )
          })}
        </div>
        <p id={`${id}-message`} className={cn('mt-1.5 text-xs', error ? 'text-danger' : 'text-ink-subtle')}>
          {error ?? hint ?? (limits ? `Choose ${limits}.` : 'Choose any.')}
        </p>
      </fieldset>
    )
  }
  if (type === 'json') {
    return <TextAreaField id={id} label={label} value={text} onChange={(e) => onChange(e.target.value)} error={error} hint={hint ?? 'JSON, checked against the parameter’s schema.'} rows={6} className="[&_textarea]:font-mono [&_textarea]:text-xs" disabled={disabled} spellCheck={false} />
  }
  if (type === 'duration') {
    const seconds = parseDuration(text)
    const reading = seconds !== null && text.trim() !== formatDuration(seconds) ? `That is ${formatDuration(seconds)}.` : null
    return (
      <TextField
        id={id}
        label={label}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        error={error}
        hint={hint ?? reading ?? 'Like 90 (minutes), 1h 30m, 2 d or 45s.'}
        autoComplete="off"
        disabled={disabled}
      />
    )
  }
  const numeric = type === 'integer' || type === 'number'
  const trailing = numeric && rules.unit ? <span className="text-xs">{rules.unit}</span> : undefined
  return (
    <TextField
      id={id}
      label={label}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      error={error}
      hint={hint ?? (numeric ? (rangeOf(rules) ?? undefined) : rules.max_length !== undefined ? `At most ${rules.max_length} characters.` : undefined)}
      trailing={trailing}
      type={secret ? 'password' : type === 'email' ? 'email' : type === 'url' ? 'url' : 'text'}
      inputMode={type === 'integer' ? 'numeric' : type === 'number' ? 'decimal' : undefined}
      autoComplete="off"
      disabled={disabled}
      spellCheck={type === 'text' ? undefined : false}
    />
  )
}
