import { BarChart3, Clock3, ShieldCheck, Truck } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { Button, TextField } from '@/components/ui'
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

const EMAIL_FORMAT_MESSAGE = 'Enter a valid email address, like name@example.com.'

// Close to the API's rule (zod's email check): one @, no spaces, a dot in the
// domain and a top-level domain of 2+ letters. The form has `noValidate`, so
// this replaces the browser's check, which accepts `name@host`. Anything this
// lets through that the API still rejects comes back as VALIDATION_FAILED
// and is shown on the field (see onSubmit).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/

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
    else if (!EMAIL_PATTERN.test(email.trim())) errors.email = EMAIL_FORMAT_MESSAGE
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
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED' && err.details.some((d) => d.field === 'email')) {
        // The API's email rule is stricter than the pattern above in a few
        // cases (e.g. a domain label starting with '-'): show it on the field.
        setFieldErrors({ email: EMAIL_FORMAT_MESSAGE })
      } else {
        setFormError((err instanceof ApiError && MESSAGES[err.code]) || FALLBACK_MESSAGE)
      }
      setSubmitting(false)
    } finally {
      inFlight.current = false
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="relative hidden w-[46%] max-w-[640px] overflow-hidden bg-[#0B0D1A] p-12 text-white lg:flex lg:flex-col">
        {/* Soft light and a faint grid behind the brand panel. */}
        <div aria-hidden="true" className="absolute -left-32 -top-32 h-[480px] w-[480px] rounded-full bg-indigo-600/40 blur-[120px]" />
        <div aria-hidden="true" className="absolute -bottom-40 right-0 h-[420px] w-[420px] rounded-full bg-purple-600/25 blur-[120px]" />
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
        />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-inset ring-white/20 backdrop-blur">
            <Truck className="h-5 w-5" aria-hidden="true" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Fleet Management System</span>
        </div>
        <div className="relative mt-auto">
          <p className="max-w-md text-3xl font-semibold leading-tight tracking-tight">Every vehicle, trip and litre of fuel, in one place.</p>
          <ul className="mt-10 space-y-4 text-sm text-white/70">
            <li className="flex items-center gap-3">
              <Clock3 className="h-4 w-4 text-indigo-300" aria-hidden="true" /> Live fleet status for dispatch decisions
            </li>
            <li className="flex items-center gap-3">
              <BarChart3 className="h-4 w-4 text-indigo-300" aria-hidden="true" /> Fuel reconciliation and maintenance insight
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="h-4 w-4 text-indigo-300" aria-hidden="true" /> Every change recorded in the audit log
            </li>
          </ul>
        </div>
      </aside>

      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-sm animate-scale-in">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand bg-gradient-to-br from-white/20 to-white/0 text-white shadow-glow">
              <Truck className="h-5 w-5" aria-hidden="true" />
            </div>
            <span className="text-sm font-semibold tracking-tight text-ink">Fleet Management System</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1.5 text-sm text-ink-muted">Use your work email and password.</p>
          {params.get('reason') === 'idle' && (
            <p role="status" className="mt-6 rounded-control border border-warning/25 bg-warning-soft px-3.5 py-3 text-sm text-warning">
              You were signed out after 30 minutes of inactivity.
            </p>
          )}
          <form onSubmit={onSubmit} noValidate className="mt-8">
            <TextField
              id="login-email"
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
            />
            <TextField
              id="login-password"
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
            />
            <p role="alert" className="mb-4 min-h-6 text-sm text-danger">
              {formError}
            </p>
            <Button type="submit" size="lg" fullWidth loading={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>
      </main>
    </div>
  )
}
