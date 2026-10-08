import { useRef, useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { ApiError } from '@/lib/api/errors'
import { homePathFor, safeRedirect } from '@/router/redirect'

// Fixed text per error code. The server's message is never shown, so what the
// screen says cannot drift from the rule: nothing reveals whether the email
// exists (api-contract §3.6).
const MESSAGES: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: 'Invalid email or password.',
  AUTH_ACCOUNT_DISABLED: 'Your account has been disabled. Contact your administrator.',
  RATE_LIMITED: 'Too many sign-in attempts. Try again in a few minutes.',
}
const FALLBACK_MESSAGE = 'Could not sign in. Try again.'

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}

/** S-01: the single entry point. Sign in, then back to `?redirect=` or the portal home. */
export function LoginPage() {
  const { status, session, login } = useAuth()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // State updates are async, so two fast clicks could both pass a state check.
  const inFlight = useRef(false)

  if (status === 'authenticated' && session) {
    return <Navigate to={safeRedirect(params.get('redirect'), homePathFor(session.roles))} replace />
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return

    const errors: { email?: string; password?: string } = {}
    if (!email.trim()) errors.email = 'Enter your email.'
    if (!password) errors.password = 'Enter your password.'
    setFieldErrors(errors)
    setFormError(null)
    if (errors.email || errors.password) return

    inFlight.current = true
    setSubmitting(true)
    try {
      await login(email.trim(), password)
      // Signed in: the render above navigates away.
    } catch (err) {
      setFormError((err instanceof ApiError && MESSAGES[err.code]) || FALLBACK_MESSAGE)
      setSubmitting(false)
    } finally {
      inFlight.current = false
    }
  }

  const inputClass = (invalid: boolean) =>
    `rounded border p-2 ${invalid ? 'border-fms-danger' : 'border-slate-300'} focus:outline focus:outline-2 focus:outline-fms-primary`

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold text-fms-primary">Sign in</h1>
      {params.get('reason') === 'idle' && (
        <p role="status" className="rounded bg-amber-50 p-3 text-amber-900">
          You were signed out after 30 minutes of inactivity.
        </p>
      )}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby="login-email-error"
            className={inputClass(!!fieldErrors.email)}
          />
          {/* Always rendered: a live region must exist before its text changes to be announced. */}
          <p id="login-email-error" aria-live="polite" className="min-h-5 text-sm text-fms-danger">
            {fieldErrors.email}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby="login-password-error"
            className={inputClass(!!fieldErrors.password)}
          />
          <p id="login-password-error" aria-live="polite" className="min-h-5 text-sm text-fms-danger">
            {fieldErrors.password}
          </p>
        </div>
        <p role="alert" className="min-h-6 text-fms-danger">
          {formError}
        </p>
        <button
          type="submit"
          disabled={submitting}
          aria-busy={submitting}
          className="flex items-center justify-center gap-2 rounded bg-fms-primary p-2 text-white disabled:opacity-60"
        >
          {submitting && <Spinner />}
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
