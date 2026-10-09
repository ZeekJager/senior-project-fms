import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const BASE =
  'focus-ring relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium ' +
  'transition-all duration-150 ease-smooth active:translate-y-px disabled:pointer-events-none disabled:opacity-50'

const VARIANTS: Record<ButtonVariant, string> = {
  // A light top sheen over the brand colour; the glow appears on hover.
  primary:
    'bg-brand bg-gradient-to-b from-white/[0.14] to-white/0 text-white shadow-soft ring-1 ring-inset ring-black/10 ' +
    'hover:bg-brand-strong hover:shadow-glow',
  secondary:
    'bg-surface text-ink shadow-soft ring-1 ring-inset ring-line-strong hover:bg-surface-muted hover:ring-ink-subtle/40 ' +
    'active:bg-surface-sunken',
  ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
  danger:
    'bg-danger-solid bg-gradient-to-b from-white/[0.12] to-white/0 text-white shadow-soft ring-1 ring-inset ring-black/10 ' +
    'hover:brightness-110 hover:shadow-[0_8px_24px_-8px_rgb(var(--c-danger-solid)/0.55)]',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 rounded-[10px] px-3 text-[13px]',
  md: 'h-10 rounded-control px-4 text-sm',
  lg: 'h-12 rounded-control px-5 text-[15px]',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner, sets aria-busy and blocks clicks. */
  loading?: boolean
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  fullWidth?: boolean
}

/** The app's button. `type` defaults to "button" so a button never submits a form by accident. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leadingIcon,
    trailingIcon,
    fullWidth,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className)}
      {...rest}
    >
      {loading ? <Spinner className="h-4 w-4" /> : leadingIcon}
      {children}
      {!loading && trailingIcon}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The accessible name: an icon alone says nothing to a screen reader. */
  label: string
  icon: ReactNode
  variant?: 'ghost' | 'secondary' | 'primary'
  size?: 'sm' | 'md'
}

/** A square icon-only button with its name in aria-label and a native tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        BASE,
        VARIANTS[variant],
        size === 'sm' ? 'h-8 w-8 rounded-[10px]' : 'h-10 w-10 rounded-control',
        '[&_svg]:h-4 [&_svg]:w-4',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  )
})
