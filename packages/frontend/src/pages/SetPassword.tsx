import { Check, CheckCircle2, KeyRound, Truck, XCircle } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Button, cn, TextField } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useSetPassword } from './Users/api'

// What the API's password rule says (api-contract §5.1), in words. The email
// check needs the account, so only the server makes it.
const REASONS: Record<string, string> = {
  too_short: 'Use at least 12 characters.',
  too_long: 'Use at most 128 characters.',
  contains_email: 'Choose a password that does not contain your email or name.',
  repeated_character: 'Choose a password that is not one character repeated.',
}

const INVALID_LINK = 'This link is not valid or has expired. Ask your administrator for a new one.'

/** The token from `#token=…`: in the fragment, it is never sent to a server or in a Referer. */
function tokenFrom(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? ''
}

/**
 * Public page behind an invitation or reset link (FMS-78): the user chooses
 * a password, once. Afterwards every existing session of the account ends,
 * and they sign in normally.
 */
export function SetPasswordPage() {
  const location = useLocation()
  const navigate = useNavigate()
  // Read once, then drop it from the address bar and the history entry.
  const [token] = useState(() => tokenFrom(location.hash))
  const setPassword = useSetPassword()
  const [password, setPasswordValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({})
  const [formError, setFormError] = useState<string | null>(token ? null : INVALID_LINK)
  const [done, setDone] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    if (location.hash) navigate({ pathname: location.pathname, search: location.search }, { replace: true })
  }, [])

  const longEnough = password.length >= 12
  const matches = password.length > 0 && password === confirm

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current || !token) return
    const e: typeof errors = {}
    if (!longEnough) e.password = REASONS.too_short
    else if (password.length > 128) e.password = REASONS.too_long
    if (!matches) e.confirm = 'The two passwords do not match.'
    setErrors(e)
    setFormError(null)
    if (e.password || e.confirm) return

    inFlight.current = true
    try {
      await setPassword.mutateAsync({ token, password })
      setDone(true)
    } catch (err) {
      const detail = err instanceof ApiError ? err.details[0] : undefined
      if (detail?.field === 'password') setErrors({ password: REASONS[detail.reason ?? ''] ?? 'Choose a different password.' })
      else if (detail?.field === 'token') setFormError(INVALID_LINK)
      else setFormError('Could not reach the server. Check your connection and try again.')
    } finally {
      inFlight.current = false
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-4 py-12">
      <div aria-hidden="true" className="absolute -left-40 -top-40 h-[420px] w-[420px] rounded-full bg-brand/20 blur-[120px]" />
      <div aria-hidden="true" className="absolute -bottom-40 -right-24 h-[380px] w-[380px] rounded-full bg-purple-500/15 blur-[120px]" />

      <main className="relative w-full max-w-md animate-scale-in rounded-sheet border border-line bg-surface/80 p-6 shadow-elevated backdrop-blur-xl sm:p-8">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand bg-gradient-to-br from-white/20 to-white/0 text-white shadow-glow">
            <Truck className="h-5 w-5" aria-hidden="true" />
          </div>
          <span className="text-sm font-semibold tracking-tight text-ink">Fleet Management System</span>
        </div>

        {done ? (
          <div role="status" className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success ring-1 ring-inset ring-success/20">
              <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">Password saved</h1>
            <p className="mt-1.5 text-sm text-ink-muted">You can now sign in with your email and new password. Any other sessions were signed out.</p>
            <Link to="/login" className="focus-ring mt-6 inline-flex h-11 w-full items-center justify-center rounded-control bg-brand px-4 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-strong">
              Go to sign in
            </Link>
          </div>
        ) : (
          <>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-ink">
              <KeyRound className="h-5 w-5 text-brand-ink" aria-hidden="true" />
              Choose your password
            </h1>
            <p className="mt-1.5 text-sm text-ink-muted">This link works once. Pick something long that you do not use anywhere else; a short sentence works well.</p>

            <form onSubmit={onSubmit} noValidate className="mt-8">
              <TextField
                id="new-password"
                label="New password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPasswordValue(e.target.value)}
                error={errors.password}
                disabled={!token}
              />
              <TextField
                id="confirm-password"
                label="Repeat the password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                error={errors.confirm}
                disabled={!token}
              />
              <ul className="mb-4 space-y-1.5 text-xs" aria-label="Password requirements">
                <Requirement met={longEnough}>At least 12 characters</Requirement>
                <Requirement met={matches}>Both passwords match</Requirement>
              </ul>
              <p role="alert" className="mb-4 min-h-6 text-sm text-danger">
                {formError}
              </p>
              <Button type="submit" size="lg" fullWidth loading={setPassword.isPending} disabled={!token}>
                Save password
              </Button>
            </form>
          </>
        )}
      </main>
    </div>
  )
}

function Requirement({ met, children }: { met: boolean; children: string }) {
  return (
    <li className={cn('flex items-center gap-2 transition-colors', met ? 'text-success' : 'text-ink-subtle')}>
      {met ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <XCircle className="h-3.5 w-3.5" aria-hidden="true" />}
      {children}
      <span className="sr-only">{met ? '(done)' : '(not yet)'}</span>
    </li>
  )
}
