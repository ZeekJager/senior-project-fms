import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Channels } from './api'

// FMS-93: S-29 Notification settings. The API is faked; so is the browser's push machinery (lib/push), which jsdom lacks.

const push = vi.hoisted(() => ({
  support: 'supported' as 'supported' | 'unsupported' | 'no-worker',
  permission: 'default' as NotificationPermission,
  subscription: null as { endpoint: string } | null,
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}))

vi.mock('@/lib/push', async (original) => ({
  ...(await original<typeof import('@/lib/push')>()),
  pushSupport: () => push.support,
  pushPermission: () => push.permission,
  currentSubscription: async () => push.subscription,
  enablePush: push.enablePush,
  disablePush: push.disablePush,
  // The fingerprint the server would give: here, the endpoint's last part.
  endpointKey: async (endpoint: string) => endpoint.split('/').pop(),
}))

const KEY = 'B'.repeat(87)
const channels = (over: Partial<Channels> = {}): Channels => ({
  rules: [
    { severity: 'critical', channels: ['in_app', 'email', 'sms', 'push'] },
    { severity: 'high', channels: ['in_app', 'push'] },
    { severity: 'medium', channels: ['in_app'] },
    { severity: 'low', channels: ['in_app'] },
  ],
  email: { available: true, address: 'sam@fms.local' },
  sms: { available: true, phone: '+251 911 234567' },
  push: { available: true, public_key: KEY, devices: 0, device_keys: [] },
  ...over,
})

function serve(first: Channels, after: Channels = first) {
  let calls = 0
  server.use(http.get('/api/v1/notifications/channels', () => envelope(calls++ === 0 ? first : after)))
}

async function open() {
  signedInAs(currentUser(['dispatcher'], ['notification:read', 'alert:read']))
  renderApp('/notification-settings')
  return screen.findByRole('region', { name: 'Alert notifications' })
}

beforeEach(() => {
  push.support = 'supported'
  push.permission = 'default'
  push.subscription = null
  push.enablePush.mockReset().mockResolvedValue(undefined)
  push.disablePush.mockReset().mockResolvedValue(undefined)
})

describe('S-29 Notification settings (FMS-93)', () => {
  it('shows which alerts reach the user where, and their email and phone', async () => {
    serve(channels())
    const alerts = await open()
    const critical = within(alerts).getByRole('list', { name: 'Critical alerts' })
    expect(within(critical).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['In FMS', 'Email', 'SMS', 'Push'])
    expect(within(within(alerts).getByRole('list', { name: 'Low alerts' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['In FMS'])
    expect(within(alerts).getByText('sam@fms.local')).toBeInTheDocument()
    expect(within(alerts).getByText('+251 911 234567')).toBeInTheDocument()
    // Outside the menu: the header names the page, not a portal.
    expect((await screen.findAllByRole('banner'))[0]).toHaveTextContent('Notification settings')
  })

  it('says when there is no phone number, or a channel is not set up', async () => {
    serve(channels({ sms: { available: true, phone: null }, email: { available: false, address: 'sam@fms.local' } }))
    const alerts = await open()
    expect(within(alerts).getByText(/No phone number on your account/)).toBeInTheDocument()
    expect(within(alerts).getByText('Not set up on this server')).toBeInTheDocument()
  })

  it('turns push on with the server’s key, then shows it on', async () => {
    serve(channels(), channels({ push: { available: true, public_key: KEY, devices: 1, device_keys: ['this-browser'] } }))
    push.enablePush.mockImplementation(async () => {
      push.subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser' }
    })
    const user = userEvent.setup()
    await open()
    const section = screen.getByRole('region', { name: 'Push in this browser' })
    await user.click(await within(section).findByRole('button', { name: 'Turn on push' }))
    expect(push.enablePush).toHaveBeenCalledWith(expect.anything(), KEY)
    expect(await screen.findByText('Push is on')).toBeInTheDocument()
    expect(await within(section).findByText('Push is on in this browser')).toBeInTheDocument()
  })

  it('push on here: sends a test, and turns off', async () => {
    push.subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/mine' }
    serve(channels({ push: { available: true, public_key: KEY, devices: 2, device_keys: ['mine', 'laptop'] } }))
    let tested = 0
    server.use(
      http.post('/api/v1/notifications/push/test', () => {
        tested += 1
        return envelope({ devices: 2, sent: 2, failed: 0 })
      }),
    )
    const user = userEvent.setup()
    await open()
    const section = screen.getByRole('region', { name: 'Push in this browser' })
    expect(await within(section).findByText('Push is on in this browser')).toBeInTheDocument()
    expect(within(section).getByText('Also on in 1 other browser of yours.')).toBeInTheDocument()
    await user.click(within(section).getByRole('button', { name: 'Send a test' }))
    expect(await screen.findByText('Test push sent')).toBeInTheDocument()
    expect(tested).toBe(1)
    await user.click(within(section).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(push.disablePush).toHaveBeenCalled())
    expect(await screen.findByText('Push is off in this browser')).toBeInTheDocument()
  })

  it('a subscription someone else turned on in this browser is not the user’s: push is off for them', async () => {
    push.subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/someone-elses' }
    serve(channels({ push: { available: true, public_key: KEY, devices: 1, device_keys: ['their-phone'] } }))
    await open()
    const section = screen.getByRole('region', { name: 'Push in this browser' })
    expect(await within(section).findByText('Push is off in this browser')).toBeInTheDocument()
    expect(within(section).getByText('Also on in 1 other browser of yours.')).toBeInTheDocument()
  })

  it('explains why push cannot be turned on: blocked, not set up, or no browser support', async () => {
    push.permission = 'denied'
    serve(channels())
    await open()
    expect(await screen.findByText('Notifications are blocked for FMS')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn on push' })).not.toBeInTheDocument()
  })

  it('a refused permission prompt says so', async () => {
    serve(channels())
    const { PushRefused } = await import('@/lib/push')
    push.enablePush.mockRejectedValue(new PushRefused('denied'))
    const user = userEvent.setup()
    await open()
    await user.click(await screen.findByRole('button', { name: 'Turn on push' }))
    expect(await screen.findByText('Push was not turned on')).toBeInTheDocument()
    expect(screen.getByText('Notifications are blocked for this site.')).toBeInTheDocument()
  })

  it('without a push provider, or in a browser without push', async () => {
    serve(channels({ push: { available: false, public_key: null, devices: 0, device_keys: [] } }))
    await open()
    expect(await screen.findByText('Push is not set up on this server')).toBeInTheDocument()
  })

  it('in a browser without push support', async () => {
    push.support = 'unsupported'
    serve(channels())
    await open()
    expect(await screen.findByText('This browser cannot receive push')).toBeInTheDocument()
  })
})
