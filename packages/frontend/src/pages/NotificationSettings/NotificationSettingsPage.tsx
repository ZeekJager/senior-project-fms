import { Bell, BellOff, BellRing, Mail, MessageSquare, Send, Smartphone } from 'lucide-react'
import type { ReactNode } from 'react'
import { ErrorState } from '@/components/shared'
import { Badge, Button, Card, Skeleton, cn, useToast, type BadgeTone } from '@/components/ui'
import { PushRefused } from '@/lib/push'
import { useChannels, usePushActions, usePushState, type Channel, type Channels, type PushState, type Severity } from './api'

const SEVERITY: Record<Severity, { label: string; tone: BadgeTone }> = {
  critical: { label: 'Critical', tone: 'danger' },
  high: { label: 'High', tone: 'warning' },
  medium: { label: 'Medium', tone: 'info' },
  low: { label: 'Low', tone: 'neutral' },
}

const CHANNEL: Record<Channel, { label: string; icon: ReactNode }> = {
  in_app: { label: 'In FMS', icon: <Bell aria-hidden="true" /> },
  email: { label: 'Email', icon: <Mail aria-hidden="true" /> },
  sms: { label: 'SMS', icon: <MessageSquare aria-hidden="true" /> },
  push: { label: 'Push', icon: <Smartphone aria-hidden="true" /> },
}

/** What push in this browser is doing, in a sentence. */
const PUSH_STATUS: Record<PushState['kind'], { title: string; detail: string }> = {
  on: { title: 'Push is on in this browser', detail: 'Critical and high alerts appear on this device, even when FMS is closed.' },
  off: { title: 'Push is off in this browser', detail: 'Turn it on to hear about critical and high alerts when FMS is closed.' },
  denied: {
    title: 'Notifications are blocked for FMS',
    detail: 'This browser was told not to show notifications from this site. Allow them in the browser’s site settings, then turn push on.',
  },
  unavailable: { title: 'Push is not set up on this server', detail: 'An administrator turns it on by adding a push provider (docs/notification-channels.md).' },
  unsupported: { title: 'This browser cannot receive push', detail: 'Use a recent Chrome, Edge, Firefox or Safari. On an iPhone, add FMS to the Home Screen first.' },
  'no-worker': { title: 'Push needs the built app', detail: 'The development server has no service worker; push works in a production build.' },
}

function Section({ id, title, description, children }: { id: string; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5 sm:p-6" aria-labelledby={id} role="region">
      <h2 id={id} className="text-base font-semibold text-ink">
        {title}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>
      <div className="mt-5">{children}</div>
    </Card>
  )
}

function Rules({ channels }: { channels: Channels }) {
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Where each severity of alert reaches you</caption>
      <thead>
        <tr className="border-b border-line text-xs text-ink-muted">
          <th scope="col" className="w-32 py-2 pr-4 font-medium">
            Severity
          </th>
          <th scope="col" className="py-2 font-medium">
            Reaches you
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {channels.rules.map((rule) => (
          <tr key={rule.severity}>
            <th scope="row" className="py-2.5 pr-4 font-normal">
              <Badge tone={SEVERITY[rule.severity].tone} dot>
                {SEVERITY[rule.severity].label}
              </Badge>
            </th>
            <td className="py-2.5">
              <ul className="flex flex-wrap gap-1.5" aria-label={`${SEVERITY[rule.severity].label} alerts`}>
                {rule.channels.map((c) => (
                  <li key={c}>
                    <Badge tone={c === 'in_app' ? 'neutral' : 'info'} icon={CHANNEL[c].icon}>
                      {CHANNEL[c].label}
                    </Badge>
                  </li>
                ))}
              </ul>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Destination({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-surface-muted text-ink-muted [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-muted">{label}</p>
        <div className="mt-0.5 text-sm text-ink [overflow-wrap:anywhere]">{children}</div>
      </div>
    </div>
  )
}

function Destinations({ channels }: { channels: Channels }) {
  const off = <span className="text-ink-subtle">Not set up on this server</span>
  return (
    <div className="mt-5 divide-y divide-line border-t border-line">
      <Destination icon={<Mail />} label="Email">
        {channels.email.available ? channels.email.address : off}
      </Destination>
      <Destination icon={<MessageSquare />} label="SMS">
        {!channels.sms.available ? (
          off
        ) : channels.sms.phone ? (
          <span className="tabular">{channels.sms.phone}</span>
        ) : (
          <span className="text-ink-muted">No phone number on your account. An administrator can add one under Users &amp; roles.</span>
        )}
      </Destination>
    </div>
  )
}

function PushPanel({ channels }: { channels: Channels }) {
  const { toast } = useToast()
  const state = usePushState(channels)
  const { enable, disable, test } = usePushActions()
  const kind = state.data?.kind
  const busy = enable.isPending || disable.isPending

  const turnOn = () =>
    enable.mutate(channels.push.public_key!, {
      onSuccess: () => toast({ title: 'Push is on', description: 'Send a test to see it arrive.' }),
      onError: (error) =>
        toast({
          tone: 'danger',
          title: 'Push was not turned on',
          description: error instanceof PushRefused && error.reason === 'denied' ? 'Notifications are blocked for this site.' : 'Try again in a moment.',
        }),
    })
  const turnOff = () =>
    disable.mutate(undefined, {
      onSuccess: () => toast({ title: 'Push is off in this browser' }),
      onError: () => toast({ tone: 'danger', title: 'Push was not turned off', description: 'Try again in a moment.' }),
    })
  const sendTest = () =>
    test.mutate(undefined, {
      onSuccess: (r) =>
        toast(
          r.sent > 0
            ? { title: 'Test push sent', description: r.devices === 1 ? 'It should appear in a few seconds.' : `To ${r.sent} of your ${r.devices} browsers.` }
            : { tone: 'danger', title: 'The test push did not go out', description: 'Turn push off and on again in this browser.' },
        ),
      onError: () => toast({ tone: 'danger', title: 'The test push did not go out', description: 'Try again in a moment.' }),
    })

  if (!kind) return <Skeleton className="h-20 w-full" />
  const status = PUSH_STATUS[kind]
  const others = channels.push.devices - (kind === 'on' ? 1 : 0)
  return (
    <div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        {/* At least 18rem, so on a phone the buttons go below the text rather than squeeze it. */}
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
          <span
            className={cn(
              'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full [&_svg]:h-4 [&_svg]:w-4',
              kind === 'on' ? 'bg-success-soft text-success' : 'bg-surface-muted text-ink-muted',
            )}
          >
            {kind === 'on' ? <BellRing aria-hidden="true" /> : <BellOff aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink" role="status">
              {status.title}
            </p>
            <p className="mt-0.5 text-sm text-ink-muted">{status.detail}</p>
            {others > 0 && (
              <p className="mt-1 text-xs text-ink-subtle">
                Also on in {others} other {others === 1 ? 'browser' : 'browsers'} of yours.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {kind === 'off' && (
            <Button onClick={turnOn} loading={enable.isPending} disabled={busy} leadingIcon={<BellRing className="h-4 w-4" />}>
              Turn on push
            </Button>
          )}
          {kind === 'on' && (
            <>
              <Button variant="secondary" onClick={sendTest} loading={test.isPending} leadingIcon={<Send className="h-4 w-4" />}>
                Send a test
              </Button>
              <Button variant="ghost" onClick={turnOff} loading={disable.isPending} disabled={busy}>
                Turn off
              </Button>
            </>
          )}
        </div>
      </div>
      {(kind === 'on' || kind === 'off') && (
        <p className="mt-5 border-t border-line pt-4 text-xs text-ink-subtle">
          Push stays on after you sign out, so you hear about critical alerts when you are not signed in. On a shared computer, turn it off before you
          leave.
        </p>
      )}
    </div>
  )
}

/**
 * S-29 Notification settings (FMS-93): how alerts reach the signed-in user. Every alert for their role is in their notifications;
 * critical ones also go by email and SMS, critical and high ones by push to the browsers they turn it on in, while
 * those channels are set up on the server. Open to every signed-in user, from the account card.
 */
export function NotificationSettingsPage() {
  const channels = useChannels()
  return (
    <div className="space-y-6">
      <header className="border-b border-line pb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Settings</h1>
        <p className="mt-1 max-w-xl text-sm text-ink-muted">How FMS reaches you when something needs attention.</p>
      </header>

      {channels.isError ? (
        <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
      ) : !channels.data ? (
        <div className="space-y-6">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : (
        <>
          <Section
            id="settings-alerts"
            title="Alert notifications"
            description="Every alert for your role is in your notifications. The most urgent also reach you outside FMS, so you hear about them when you are away."
          >
            <Rules channels={channels.data} />
            <Destinations channels={channels.data} />
          </Section>
          <Section id="settings-push" title="Push in this browser" description="Alerts as notifications on this device, from the browser, even when FMS is closed.">
            <PushPanel channels={channels.data} />
          </Section>
        </>
      )}
    </div>
  )
}
