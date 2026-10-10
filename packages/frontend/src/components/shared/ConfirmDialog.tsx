import { AlertCircle } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Dialog, TextField } from '@/components/ui'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  title: string
  message: ReactNode
  /** The confirm button's text, e.g. "Decommission vehicle". */
  action: string
  onConfirm: () => void | Promise<void>
  /** The user must type exactly this (e.g. the plate) before the action is enabled. */
  requireTyping?: string
  /** A failure to show inside the dialog, next to the action, never as a toast. */
  error?: ReactNode
  busy?: boolean
  tone?: 'danger' | 'default'
}

/**
 * For irreversible actions. With `requireTyping`, confirm stays disabled until
 * the typed text matches exactly (case and spaces included).
 */
export function ConfirmDialog({ open, onClose, title, message, action, onConfirm, requireTyping, error, busy, tone = 'danger' }: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const matches = requireTyping === undefined || typed === requireTyping

  return (
    <Dialog open={open} onClose={onClose} title={title} initialFocus={requireTyping !== undefined ? input : undefined}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (matches && !busy) void onConfirm()
        }}
      >
        <div className="text-sm text-ink-muted">{message}</div>
        {requireTyping !== undefined && (
          <TextField
            ref={input}
            className="mt-5"
            label={`Type ${requireTyping} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <div role="alert" className={error ? (requireTyping !== undefined ? 'mt-1' : 'mt-4') : undefined}>
          {error && (
            <div className="flex items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger animate-fade-in">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div>{error}</div>
            </div>
          )}
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={tone === 'danger' ? 'danger' : 'primary'} disabled={!matches} loading={busy}>
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
