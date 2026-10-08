import { useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { ApiError } from '@/lib/api/errors'
import { homePathFor, safeRedirect } from '@/router/redirect'

// Minimal sign-in form so the redirect flow works end to end. FMS-10 replaces
// it with the designed screen; the redirect handling below stays.
export function LoginPage() {
  const { status, session, login } = useAuth()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (status === 'authenticated' && session) {
    // Back to the page the visitor was after, or their portal's home.
    return <Navigate to={safeRedirect(params.get('redirect'), homePathFor(session.roles))} replace />
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.')
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold text-fms-primary">Sign in</h1>
      {params.get('reason') === 'idle' && (
        <p role="status" className="rounded bg-amber-50 p-3 text-amber-900">
          You were signed out after 30 minutes of inactivity.
        </p>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          Email
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-slate-300 p-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          Password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded border border-slate-300 p-2"
          />
        </label>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting} className="rounded bg-fms-primary p-2 text-white disabled:opacity-60">
          Sign in
        </button>
      </form>
    </main>
  )
}
