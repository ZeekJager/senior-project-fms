import type { BadgeTone } from '@/components/ui'
import type { Provider, ProviderStatus } from './api'

// How S-34 words providers and devices: Addis Ababa times, states, and why a position was refused.

const TZ = 'Africa/Addis_Ababa'
const whenFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** 4 Nov, 14:05; "Never" for none. */
export const when = (iso: string | null) => (iso ? whenFormat.format(new Date(iso)) : 'Never')

/** "just now", "4 min ago", "3 h ago", else the date and time. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Never'
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  return when(iso)
}

export const STATUS: Record<ProviderStatus, { label: string; tone: BadgeTone }> = {
  operational: { label: 'Receiving', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  down: { label: 'Down', tone: 'danger' },
  unknown: { label: 'Nothing yet', tone: 'neutral' },
  inactive: { label: 'Switched off', tone: 'neutral' },
}

/** Why a position was refused, in words. */
const REASONS: Record<string, string> = {
  too_old: 'Older than 7 days',
  future_timestamp: 'Clock ahead of the server',
  low_accuracy: 'Imprecise fix (over 500 m)',
  vehicle_retired: 'Vehicle retired',
  unknown_device: 'Not linked to a vehicle',
}
export const reasonLabel = (reason: string) => REASONS[reason] ?? reason.replace(/_/g, ' ')

/** What stops a provider's positions from arriving, if anything: the first thing an admin should fix. */
export function blocker(p: Provider): string | null {
  if (!p.is_active) return 'Switched off: its webhooks are refused.'
  if (!p.webhook_secret_configured) return `No webhook secret: set INTEGRATION_${p.code.toUpperCase().replace(/-/g, '_')}_WEBHOOK_SECRET on the server.`
  if (p.today.deliveries === 0 && p.today.deliveries_rejected > 0) return 'Every delivery today was refused: check the shared secret and the provider’s clock.'
  if ((p.devices?.unknown ?? 0) > 0 && (p.devices?.linked ?? 0) === 0) return 'Sending devices that are not linked yet: link them below.'
  return null
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`
