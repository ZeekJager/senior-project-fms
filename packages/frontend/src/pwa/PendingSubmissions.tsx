import { AlertTriangle, CloudUpload, Loader2, Trash2, WifiOff } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, cn, Drawer } from '@/components/ui'
import type { Submission } from '@/lib/offlineQueue'
import { useOfflineQueue } from './OfflineQueue'

const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function badgeLabel(pending: number, rejected: number, sending: boolean): string {
  const parts = []
  if (rejected) parts.push(`${rejected} not sent`)
  if (pending) parts.push(sending ? `sending ${pending}` : `${pending} waiting to send`)
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The pending badge in the driver app's top bar (FMS-81): how many
 * submissions are on this phone waiting for the server, and whether any was
 * turned down. Hidden while there are none. Opens the list.
 */
export function PendingSubmissions() {
  const { items, pending, rejected, sending, online, sendNow, remove } = useOfflineQueue()
  const [open, setOpen] = useState(false)
  if (items.length === 0 && !open) return null

  const label = badgeLabel(pending, rejected, sending)
  const Icon = rejected ? AlertTriangle : sending ? Loader2 : CloudUpload

  return (
    <>
      {items.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={label}
          className={cn(
            'focus-ring flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold tabular-nums ring-1 ring-inset',
            rejected ? 'bg-danger-soft text-danger ring-danger/25' : 'bg-warning-soft text-warning ring-warning/30',
        )}
      >
        <Icon className={cn('h-4 w-4', sending && !rejected && 'animate-spin')} aria-hidden="true" />
        {pending + rejected}
      </button>
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Waiting to send"
        description="Kept on this phone until the server has them, and sent in the order you made them."
        footer={
          <Button fullWidth leadingIcon={online ? <CloudUpload className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />} disabled={!online || pending === 0} loading={sending} onClick={sendNow}>
            {online ? 'Send now' : 'Needs signal'}
          </Button>
        }
      >
        {items.length === 0 ? (
          <p className="text-sm text-ink-muted">Everything has been sent.</p>
        ) : (
          <ol className="space-y-3">
            {items.map((item, i) => (
              <Entry key={item.seq} item={item} sendingNow={sending && i === items.findIndex((s) => s.state === 'pending')} onRemove={() => void remove(item.seq)} />
            ))}
          </ol>
        )}
      </Drawer>
    </>
  )
}

function Entry({ item, sendingNow, onRemove }: { item: Submission; sendingNow: boolean; onRemove: () => void }) {
  const refused = item.state === 'rejected'
  return (
    <li className={cn('rounded-card border p-3', refused ? 'border-danger/30 bg-danger-soft/40' : 'border-line bg-surface')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">{item.label}</p>
          <p className="text-xs text-ink-muted">Made {when.format(item.queuedAt)}</p>
        </div>
        {refused ? (
          <Badge tone="danger">Not sent</Badge>
        ) : sendingNow ? (
          <Badge tone="brand">Sending</Badge>
        ) : (
          <Badge tone="warning">Waiting</Badge>
        )}
      </div>
      {refused && (
        <div className="mt-2 flex items-end justify-between gap-3">
          <p className="text-sm text-danger">The server turned it down: {item.rejection?.message}</p>
          <Button size="sm" variant="secondary" leadingIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={onRemove} aria-label={`Remove ${item.label}`}>
            Remove
          </Button>
        </div>
      )}
    </li>
  )
}
