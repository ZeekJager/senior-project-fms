import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, Dialog } from '@/components/ui'
import { passwordLinkUrl, type PasswordLink } from './api'

interface PasswordLinkDialogProps {
  /** The link and who it is for; null closes the dialog. */
  link: { link: PasswordLink; name: string; email: string } | null
  onClose: () => void
}

const formatExpiry = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * Shows a one-time password link once. The API keeps only its hash, so
 * closing this dialog loses it: a new one can be issued from the user's
 * record at any time.
 */
export function PasswordLinkDialog({ link, onClose }: PasswordLinkDialogProps) {
  const [copied, setCopied] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const url = link ? passwordLinkUrl(link.link.token) : ''

  useEffect(() => setCopied(false), [link])

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // No clipboard permission: select the text so Ctrl+C works.
      field.current?.select()
    }
  }

  const setup = link?.link.purpose === 'setup'
  return (
    <Dialog
      open={link !== null}
      onClose={onClose}
      title={setup ? 'Invitation link ready' : 'Password reset link ready'}
      description={link ? `For ${link.name} · ${link.email}` : undefined}
      initialFocus={field}
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-control border border-brand/20 bg-brand-soft/60 p-3.5 text-sm text-ink">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-brand-ink" aria-hidden="true" />
          <p>
            Send this link to {link?.name.split(' ')[0] ?? 'the user'} through a channel you trust. It lets them choose{' '}
            {setup ? 'their first password' : 'a new password'} once, until <strong className="font-semibold">{link ? formatExpiry(link.link.expires_at) : ''}</strong>.
          </p>
        </div>

        <div className="flex gap-2">
          <label htmlFor="password-link" className="sr-only">
            One-time link
          </label>
          <input
            ref={field}
            id="password-link"
            readOnly
            value={url}
            onFocus={(e) => e.target.select()}
            className="focus-ring h-11 min-w-0 flex-1 rounded-control border border-line-strong bg-surface-sunken px-3.5 font-mono text-xs text-ink"
          />
          <Button onClick={() => void copy()} leadingIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} aria-live="polite">
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <p className="flex items-start gap-2 text-xs text-ink-subtle">
          <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          This link is shown only now. If it is lost or expires, issue a new one from the user’s record; older links stop working.
        </p>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
