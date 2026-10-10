import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Role, User } from './api'

const ADMIN_PERMS = ['users:read', 'users:write', 'roles:read', 'depot:read', 'vehicle:read', 'trip:read', 'audit:read']
const admin = currentUser(['admin'], ADMIN_PERMS)
const manager = currentUser(['fleet_manager'], ['users:read', 'roles:read', 'depot:read', 'vehicle:read', 'trip:read'])
// Not a seeded grant: a non-admin who may write users, to show the escalation guard.
const writerWithoutAdmin = currentUser(['fleet_manager'], ['users:read', 'users:write', 'roles:read', 'depot:read', 'vehicle:read', 'trip:read'])
const driver = currentUser(['driver'], ['vehicle:read', 'trip:execute'])

const roles: Role[] = [
  { name: 'admin', description: 'Full access', permissions: ADMIN_PERMS },
  { name: 'dispatcher', description: 'Plans trips in one depot', permissions: ['trip:read', 'vehicle:read'] },
  { name: 'fleet_owner', description: 'Reads the fleet', permissions: ['vehicle:read', 'audit:read'] },
]

let seq = 0
function user(overrides: Partial<User> = {}): User {
  seq += 1
  return {
    id: `u-${seq + 10}`,
    email: `person${seq}@fms.local`,
    full_name: `Person ${seq}`,
    phone: null,
    depot_id: null,
    status: 'active',
    roles: ['fleet_owner'],
    has_password: true,
    last_login_at: '2026-10-09T07:30:00Z',
    created_at: '2026-10-01T08:00:00Z',
    updated_at: '2026-10-01T08:00:00Z',
    ...overrides,
  }
}

/** A fake user directory: list (with status counts), roles and depots; records list queries. */
function serveUsers(users: User[]) {
  const queries: URLSearchParams[] = []
  server.use(
    http.get('/api/v1/users', ({ request }) => {
      const q = new URL(request.url).searchParams
      if (q.get('page_size') !== '1') queries.push(q)
      let rows = users
      if (q.get('status')) rows = rows.filter((u) => u.status === q.get('status'))
      if (q.get('role')) rows = rows.filter((u) => u.roles.includes(q.get('role')!))
      const size = Number(q.get('page_size') ?? 25)
      return HttpResponse.json({ data: rows.slice(0, size), meta: { page: 1, page_size: size, total_items: rows.length, total_pages: 1 } })
    }),
    http.get('/api/v1/roles', () => envelope(roles)),
    http.get('/api/v1/depots', () => envelope([{ id: 'd-1', name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }])),
  )
  return { queries }
}

const table = () => screen.getByRole('table', { name: 'Users' })
const rowOf = (name: string) => within(table()).getByText(name).closest('tr') as HTMLElement

async function openUsers(firstName: string, as = admin) {
  signedInAs(as)
  renderApp('/users')
  await within(await screen.findByRole('table', { name: 'Users' })).findByText(firstName)
}

describe('Users and roles', () => {
  it('lists accounts with roles and status; an account without a password shows as Invited', async () => {
    serveUsers([user({ full_name: 'Abebe Kebede', roles: ['admin'] }), user({ full_name: 'Hanna Dispatcher', roles: ['dispatcher'], has_password: false, depot_id: 'd-1' })])
    await openUsers('Abebe Kebede')
    expect(within(rowOf('Abebe Kebede')).getAllByText('Administrator')[0]).toBeInTheDocument()
    expect(within(rowOf('Hanna Dispatcher')).getAllByText('Invited')[0]).toBeInTheDocument()
    expect(await within(rowOf('Hanna Dispatcher')).findByText('Addis Ababa Central')).toBeInTheDocument()
  })

  it('an admin invites a user: the form sends the account and the one-time link is shown once', async () => {
    serveUsers([user({ full_name: 'Abebe Kebede' })])
    let sent: unknown
    server.use(
      http.post('/api/v1/users', async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(
          { data: user({ full_name: 'Hanna Dispatcher', email: 'hanna@fms.local', roles: ['dispatcher'], has_password: false }), meta: { password_setup: { token: 'tok_abc123', purpose: 'setup', expires_at: '2026-10-13T08:00:00Z' }, request_id: 'r' } },
          { status: 201 },
        )
      }),
    )
    const u = userEvent.setup()
    await openUsers('Abebe Kebede')

    await u.click(screen.getByRole('button', { name: 'Invite user' }))
    const drawer = await screen.findByRole('dialog', { name: 'Invite a user' })
    await u.type(within(drawer).getByLabelText('Full name'), 'Hanna Dispatcher')
    await u.type(within(drawer).getByLabelText('Work email'), 'hanna@fms.local')
    await u.click(await within(drawer).findByRole('checkbox', { name: /Dispatcher/ }))
    await u.click(within(drawer).getByRole('button', { name: 'Create account' }))
    // Dispatchers work in one depot.
    expect(await within(drawer).findByText(/choose their home depot/)).toBeInTheDocument()
    expect(sent).toBeUndefined()

    await u.selectOptions(within(drawer).getByLabelText(/Home depot/), 'd-1')
    await u.click(within(drawer).getByRole('button', { name: 'Create account' }))

    const dialog = await screen.findByRole('dialog', { name: 'Invitation link ready' })
    expect(sent).toEqual({ email: 'hanna@fms.local', full_name: 'Hanna Dispatcher', phone: null, depot_id: 'd-1', roles: ['dispatcher'] })
    expect(within(dialog).getByLabelText('One-time link')).toHaveValue(`${window.location.origin}/set-password#token=tok_abc123`)
    expect(within(dialog).getByText(/shown only now/)).toBeInTheDocument()
  })

  it('a reader sees the directory but no way to change it', async () => {
    serveUsers([user({ full_name: 'Abebe Kebede' })])
    await openUsers('Abebe Kebede', manager)
    expect(screen.queryByRole('button', { name: 'Invite user' })).not.toBeInTheDocument()
    expect(within(rowOf('Abebe Kebede')).queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Roles' })).toBeInTheDocument()
  })

  it('without the admin role, the admin role cannot be granted and an admin account is read-only', async () => {
    serveUsers([user({ full_name: 'Abebe Kebede', roles: ['admin'] }), user({ full_name: 'Selam Owner', roles: ['fleet_owner'] })])
    const u = userEvent.setup()
    await openUsers('Abebe Kebede', writerWithoutAdmin)

    await u.click(within(rowOf('Selam Owner')).getByRole('button', { name: 'Edit Selam Owner' }))
    let drawer = await screen.findByRole('dialog', { name: 'Edit Selam Owner' })
    expect(await within(drawer).findByRole('checkbox', { name: /Administrator/ })).toBeDisabled()
    expect(within(drawer).getAllByText('Needs permissions you do not hold').length).toBeGreaterThan(0)
    await u.click(within(drawer).getByRole('button', { name: 'Cancel' }))

    await u.click(within(rowOf('Abebe Kebede')).getByRole('button', { name: 'Edit Abebe Kebede' }))
    drawer = await screen.findByRole('dialog', { name: 'Edit Abebe Kebede' })
    expect(await within(drawer).findByText(/only an administrator can change it/)).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('your own roles and status are locked', async () => {
    serveUsers([user({ id: 'u-1', full_name: 'Sam Tester', roles: ['admin'] })])
    const u = userEvent.setup()
    await openUsers('Sam Tester')
    expect(within(rowOf('Sam Tester')).getByText('You')).toBeInTheDocument()

    await u.click(within(rowOf('Sam Tester')).getByRole('button', { name: 'Edit Sam Tester' }))
    const drawer = await screen.findByRole('dialog', { name: 'Edit Sam Tester' })
    expect(within(drawer).getByText('Another administrator changes your roles')).toBeInTheDocument()
    for (const box of await within(drawer).findAllByRole('checkbox')) expect(box).toBeDisabled()
    expect(within(drawer).getByLabelText('Account status')).toBeDisabled()
  })

  it('deactivating asks first, then sends only the status', async () => {
    const selam = user({ full_name: 'Selam Owner' })
    serveUsers([selam])
    let sent: unknown
    server.use(
      http.patch(`/api/v1/users/${selam.id}`, async ({ request }) => {
        sent = await request.json()
        return envelope({ ...selam, status: 'inactive' })
      }),
    )
    const u = userEvent.setup()
    await openUsers('Selam Owner')
    await u.click(within(rowOf('Selam Owner')).getByRole('button', { name: 'Edit Selam Owner' }))
    const drawer = await screen.findByRole('dialog', { name: 'Edit Selam Owner' })
    await u.selectOptions(within(drawer).getByLabelText('Account status'), 'inactive')
    await u.click(within(drawer).getByRole('button', { name: 'Save changes' }))

    const confirm = await screen.findByRole('dialog', { name: 'Deactivate Selam Owner?' })
    expect(within(confirm).getByText(/signs Selam out on every device/)).toBeInTheDocument()
    expect(sent).toBeUndefined()
    await u.click(within(confirm).getByRole('button', { name: 'Deactivate account' }))
    await waitFor(() => expect(sent).toEqual({ status: 'inactive' }))
    expect(await screen.findByText('Account deactivated')).toBeInTheDocument()
  })

  it("shows the server's refusal inside the form (escalation, last admin)", async () => {
    const selam = user({ full_name: 'Selam Owner' })
    serveUsers([selam])
    server.use(
      http.patch(`/api/v1/users/${selam.id}`, () =>
        errorEnvelope(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'You cannot grant or remove the admin role: it carries permissions you do not hold.', [{ field: 'roles', reason: 'escalation' }]),
      ),
    )
    const u = userEvent.setup()
    await openUsers('Selam Owner')
    await u.click(within(rowOf('Selam Owner')).getByRole('button', { name: 'Edit Selam Owner' }))
    const drawer = await screen.findByRole('dialog', { name: 'Edit Selam Owner' })
    await u.click(await within(drawer).findByRole('checkbox', { name: /Administrator/ }))
    await u.click(within(drawer).getByRole('button', { name: 'Save changes' }))
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('You cannot grant or remove the admin role')
  })

  it('issues a reset link from the user record', async () => {
    const selam = user({ full_name: 'Selam Owner' })
    serveUsers([selam])
    server.use(http.post(`/api/v1/users/${selam.id}/password-reset`, () => envelope({ token: 'reset_tok', purpose: 'reset', expires_at: '2026-10-10T09:00:00Z' })))
    const u = userEvent.setup()
    await openUsers('Selam Owner')
    await u.click(within(rowOf('Selam Owner')).getByRole('button', { name: 'Edit Selam Owner' }))
    const drawer = await screen.findByRole('dialog', { name: 'Edit Selam Owner' })
    await u.click(within(drawer).getByRole('button', { name: 'Create reset link' }))
    const dialog = await screen.findByRole('dialog', { name: 'Password reset link ready' })
    expect(within(dialog).getByLabelText('One-time link')).toHaveValue(`${window.location.origin}/set-password#token=reset_tok`)
  })

  it('renders nothing for a driver', async () => {
    signedInAs(driver)
    renderApp('/users')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
  })
})
