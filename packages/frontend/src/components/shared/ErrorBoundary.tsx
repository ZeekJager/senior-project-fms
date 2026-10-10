import { AlertTriangle, Check, Copy, RotateCcw } from 'lucide-react'
import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { Button, cn } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'

/** What support needs from a failure: the error code and, for API errors, the request (correlation) id. */
export function errorDetails(error: unknown): { code: string; message: string; requestId?: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message, requestId: error.requestId }
  if (error instanceof Error) return { code: error.name || 'Error', message: error.message }
  return { code: 'UNKNOWN_ERROR', message: String(error) }
}

interface ErrorStateProps {
  error: unknown
  /** Shown as the heading; the default suits a failed load. */
  heading?: string
  onRetry?: () => void
  className?: string
}

/**
 * A failure, explained: a plain heading, the error code and correlation id
 * for support, a way to copy them, and a retry when there is one.
 */
export function ErrorState({ error, heading = 'Something went wrong', onRetry, className }: ErrorStateProps) {
  const details = errorDetails(error)
  const [copied, setCopied] = useState(false)

  async function copy() {
    const text = [`Error: ${details.code}`, `Message: ${details.message}`, details.requestId && `Correlation ID: ${details.requestId}`]
      .filter(Boolean)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked (insecure origin, permissions): the details stay visible to copy by hand.
    }
  }

  return (
    <div role="alert" className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-danger-soft text-danger ring-1 ring-inset ring-danger/20">
        <AlertTriangle className="h-6 w-6" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold tracking-tight text-ink">{heading}</h3>
      <p className="mt-1.5 max-w-md text-sm text-ink-muted">
        We couldn&apos;t complete this request. Try again; if it keeps failing, send the details below to support.
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-control border border-line bg-surface-muted px-4 py-3 text-left font-mono text-xs text-ink-muted">
        <dt className="text-ink-subtle">Code</dt>
        <dd className="text-ink">{details.code}</dd>
        {details.requestId && (
          <>
            <dt className="text-ink-subtle">Correlation ID</dt>
            <dd className="break-all text-ink">{details.requestId}</dd>
          </>
        )}
      </dl>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {onRetry && (
          <Button variant="primary" leadingIcon={<RotateCcw className="h-4 w-4" />} onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button
          variant="secondary"
          leadingIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy error details'}
        </Button>
      </div>
    </div>
  )
}

interface ErrorBoundaryProps {
  children: ReactNode
  /** Changing this (e.g. the route) clears a caught error. */
  resetKey?: unknown
}

/** Catches render errors below it and shows ErrorState instead of a blank screen. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: unknown; resetKey: unknown }> {
  state = { error: null as unknown, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: { error: unknown; resetKey: unknown }) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Render error', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return <ErrorState error={this.state.error} onRetry={() => this.setState({ error: null })} />
    }
    return this.props.children
  }
}
