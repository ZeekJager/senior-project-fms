import { useQuery } from '@tanstack/react-query'
import { Bell, Mail, MessageSquare, Smartphone } from 'lucide-react'
import type { ReactNode } from 'react'
import { EmptyState, ErrorState } from '@/components/shared'
import { Badge, Drawer, Skeleton, type BadgeTone } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'

// FMS-93: how an alert reached the people it notified, by channel (GET /alerts/{id}/deliveries). A failed or
// retrying email, SMS or push shows why, and when the next attempt is due.

export type DeliveryChannel = 'in_app' | 'email' | 'sms' | 'push'
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'cancelled'

export interface AlertDelivery {
  id: string
  channel: DeliveryChannel
  status: DeliveryStatus
  type: string
  recipient: { id: string | null; name: string | null }
  attempts: number
  provider: string | null
  provider_message_id: string | null
  queued_at: string
  sent_at: string | null
  failed_at: string | null
  next_attempt_at: string | null
  failure_reason: string | null
  read_at: string | null
}

const CHANNELS: Record<DeliveryChannel, { label: string; icon: ReactNode }> = {
  in_app: { label: 'In FMS', icon: <Bell aria-hidden="true" /> },
  email: { label: 'Email', icon: <Mail aria-hidden="true" /> },
  sms: { label: 'SMS', icon: <MessageSquare aria-hidden="true" /> },
  push: { label: 'Push', icon: <Smartphone aria-hidden="true" /> },
}

const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const at = (iso: string) => time.format(new Date(iso))

/** A message's state in a word and a tone: a queued one that has failed before is retrying. */
export function deliveryState(d: Pick<AlertDelivery, 'channel' | 'status' | 'attempts' | 'read_at'>): { label: string; tone: BadgeTone } {
  if (d.channel === 'in_app') return d.read_at ? { label: 'Read', tone: 'success' } : { label: 'Unread', tone: 'neutral' }
  switch (d.status) {
    case 'sent':
    case 'delivered':
      return { label: 'Sent', tone: 'success' }
    case 'failed':
      return { label: 'Failed', tone: 'danger' }
    case 'cancelled':
      return { label: 'Not sent', tone: 'neutral' }
    default:
      return d.attempts > 0 ? { label: 'Retrying', tone: 'warning' } : { label: 'Sending', tone: 'info' }
  }
}

/** The line under a message: when it went, or why not and what happens next. */
export function deliveryDetail(d: AlertDelivery): string {
  const tries = d.attempts === 1 ? '1 attempt' : `${d.attempts} attempts`
  if (d.channel === 'in_app') return d.read_at ? `Read ${at(d.read_at)}` : `In their notifications since ${at(d.queued_at)}`
  if (d.status === 'sent' || d.status === 'delivered') return `Sent ${at(d.sent_at ?? d.queued_at)}${d.provider ? ` by ${d.provider}` : ''}${d.attempts > 1 ? `, after ${tries}` : ''}`
  if (d.status === 'failed') return `${d.failure_reason ?? 'Failed'} Gave up after ${tries}.`
  if (d.status === 'cancelled') return d.failure_reason ?? 'Not sent.'
  if (d.attempts > 0) return `${d.failure_reason ?? 'The last attempt failed.'} Next attempt ${d.next_attempt_at ? at(d.next_attempt_at) : 'soon'} (${tries} so far).`
  return 'Waiting to be sent.'
}

export function DeliveryDrawer({ alert, onClose }: { alert: { id: string; title: string }; onClose: () => void }) {
  const { api } = useAuth()
  const deliveries = useQuery({
    queryKey: ['alerts', alert.id, 'deliveries'],
    queryFn: () => api.request<AlertDelivery[]>(`/alerts/${alert.id}/deliveries`),
    // Retries happen in the background: keep the view current while it is open.
    refetchInterval: 15_000,
  })
  const rows = deliveries.data ?? []
  const outside = rows.filter((d) => d.channel !== 'in_app')

  return (
    <Drawer open onClose={onClose} title="Delivery" description={alert.title} className="sm:!max-w-[560px]">
      {deliveries.isError ? (
        <ErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} />
      ) : deliveries.isPending ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Bell />} heading="Nobody was notified" description="No one with this alert’s roles works at its depot." headingLevel="h3" />
      ) : (
        <div className="space-y-5">
          {outside.length === 0 && (
            <p className="text-sm text-ink-muted">Only in FMS: email, SMS and push are for critical and high alerts, on the channels set up on this server.</p>
          )}
          {(['email', 'sms', 'push', 'in_app'] as const).map((channel) => {
            const items = rows.filter((d) => d.channel === channel)
            if (items.length === 0) return null
            return (
              <section key={channel} aria-label={CHANNELS[channel].label}>
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-muted [&_svg]:h-3.5 [&_svg]:w-3.5">
                  {CHANNELS[channel].icon}
                  {CHANNELS[channel].label}
                </h3>
                <ul className="mt-2 divide-y divide-line rounded-control border border-line">
                  {items.map((d) => {
                    const state = deliveryState(d)
                    return (
                      <li key={d.id} className="flex items-start gap-3 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">
                            {d.recipient.name ?? 'Unknown user'}
                            {d.type === 'alert_escalated' && <span className="ml-1.5 text-xs font-normal text-ink-subtle">(escalation)</span>}
                          </p>
                          <p className="mt-0.5 text-xs text-ink-muted [overflow-wrap:anywhere]">{deliveryDetail(d)}</p>
                        </div>
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </Drawer>
  )
}
