import { describe, expect, it } from 'vitest'
import type { Provider } from './api'
import { ago, blocker, reasonLabel, when } from './describe'

const NOW = Date.parse('2026-11-05T12:00:00Z')

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: 'p',
  code: 'geotab-et',
  name: 'Geotab',
  provider_type: 'telematics',
  is_active: true,
  status: 'operational',
  webhook_secret_configured: true,
  last_error: null,
  last_delivery_at: null,
  today: { deliveries: 3, deliveries_rejected: 0, positions_accepted: 10, positions_rejected: 0 },
  devices: { linked: 1, unknown: 0 },
  circuit: null,
  ...over,
})

describe('S-34 wording', () => {
  it('times: just now, minutes, hours, then the Addis Ababa date and time', () => {
    expect(ago(null, NOW)).toBe('Never')
    expect(ago('2026-11-05T11:59:30Z', NOW)).toBe('just now')
    expect(ago('2026-11-05T11:41:00Z', NOW)).toBe('19 min ago')
    expect(ago('2026-11-05T07:00:00Z', NOW)).toBe('5 h ago')
    expect(ago('2026-11-03T08:05:00Z', NOW)).toBe('3 Nov, 11:05')
    expect(when('2026-11-03T08:05:00Z')).toBe('3 Nov, 11:05')
  })

  it('a refusal reason in words, an unknown one readable', () => {
    expect(reasonLabel('low_accuracy')).toBe('Imprecise fix (over 500 m)')
    expect(reasonLabel('some_new_reason')).toBe('some new reason')
  })

  it('what blocks a provider, most basic first; nothing when it is receiving', () => {
    expect(blocker(provider({ is_active: false, webhook_secret_configured: false }))).toBe('Switched off: its webhooks are refused.')
    expect(blocker(provider({ webhook_secret_configured: false }))).toBe('No webhook secret: set INTEGRATION_GEOTAB_ET_WEBHOOK_SECRET on the server.')
    expect(blocker(provider({ today: { deliveries: 0, deliveries_rejected: 4, positions_accepted: 0, positions_rejected: 0 } }))).toMatch(/^Every delivery today was refused/)
    expect(blocker(provider({ devices: { linked: 0, unknown: 2 } }))).toMatch(/^Sending devices that are not linked yet/)
    expect(blocker(provider())).toBeNull()
  })
})
