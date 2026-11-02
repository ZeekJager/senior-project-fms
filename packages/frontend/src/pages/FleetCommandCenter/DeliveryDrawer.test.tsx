import { screen, within } from '@testing-library/react'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { DeliveryDrawer, deliveryDetail, deliveryState, type AlertDelivery } from './DeliveryDrawer'

// FMS-93: how an alert reached people, from the command center's alerts.

const ALERT = '33333333-3333-4333-8333-333333333333'
const base: AlertDelivery = {
  id: 'd-1',
  channel: 'sms',
  status: 'queued',
  type: 'alert',
  recipient: { id: 'u-2', name: 'Tigist Belay' },
  attempts: 0,
  provider: null,
  provider_message_id: null,
  queued_at: '2026-10-03T05:15:00Z',
  sent_at: null,
  failed_at: null,
  next_attempt_at: null,
  failure_reason: null,
  read_at: null,
}

describe('delivery status (FMS-93)', () => {
  it('says what happened to each message, and what happens next', () => {
    expect(deliveryState(base)).toEqual({ label: 'Sending', tone: 'info' })
    const retrying = { ...base, attempts: 2, failure_reason: 'POST /messages answered 503.', next_attempt_at: '2026-10-03T05:21:00Z' }
    expect(deliveryState(retrying)).toEqual({ label: 'Retrying', tone: 'warning' })
    expect(deliveryDetail(retrying)).toBe('POST /messages answered 503. Next attempt 3 Oct, 08:21 (2 attempts so far).')
    const sent = { ...base, status: 'sent' as const, attempts: 3, provider: 'sms-et', sent_at: '2026-10-03T05:21:00Z' }
    expect(deliveryDetail(sent)).toBe('Sent 3 Oct, 08:21 by sms-et, after 3 attempts')
    const failed = { ...base, status: 'failed' as const, attempts: 5, failure_reason: 'POST /messages answered 500.' }
    expect(deliveryState(failed).label).toBe('Failed')
    expect(deliveryDetail(failed)).toBe('POST /messages answered 500. Gave up after 5 attempts.')
    expect(deliveryState({ ...base, channel: 'in_app', status: 'delivered', read_at: '2026-10-03T06:00:00Z' }).label).toBe('Read')
  })

  it('lists the messages by channel, each with who it was for', async () => {
    server.use(
      http.get(`/api/v1/alerts/${ALERT}/deliveries`, () =>
        envelope([
          { ...base, id: 'a', channel: 'in_app', status: 'delivered' },
          { ...base, id: 'b', channel: 'email', status: 'sent', attempts: 1, provider: 'smtp-main', sent_at: '2026-10-03T05:16:00Z' },
          { ...base, id: 'c', channel: 'sms', attempts: 1, failure_reason: 'POST /messages answered 503.', next_attempt_at: '2026-10-03T05:17:00Z' },
        ]),
      ),
    )
    signedInAs(currentUser(['fleet_manager'], ['alert:read']))
    renderApp('/notification-settings', { children: <DeliveryDrawer alert={{ id: ALERT, title: 'Defects reported on AA 3-77001' }} onClose={() => undefined} /> })
    const sms = await screen.findByRole('region', { name: 'SMS' })
    expect(within(sms).getByText('Tigist Belay')).toBeInTheDocument()
    expect(within(sms).getByText('Retrying')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Email' })).getByText('Sent 3 Oct, 08:16 by smtp-main')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'In FMS' })).getByText('Unread')).toBeInTheDocument()
  })
})
