import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PermissionRule } from '@/context/AuthContext'
import { currentUser, renderApp, signedInAs } from '@/test/auth'
import { RoleGate } from './RoleGate'

function gated(permission: PermissionRule) {
  return (
    <RoleGate permission={permission}>
      <button type="button">Approve</button>
    </RoleGate>
  )
}

describe('RoleGate', () => {
  it('renders its children for a user holding the permission', async () => {
    signedInAs(currentUser(['finance_clerk'], ['fuel-anomaly:write']))
    renderApp('/dashboard', { children: gated('fuel-anomaly:write') })

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('renders nothing at all, not a disabled control, without it', async () => {
    signedInAs(currentUser(['driver'], ['trip:execute']))
    const { container } = renderApp('/dashboard', { children: <div data-testid="slot">{gated('fuel-anomaly:write')}</div> })

    await screen.findByText('Sam Tester')
    expect(screen.getByTestId('slot')).toBeEmptyDOMElement()
    expect(container.querySelector('button[disabled]')).toBeNull()
  })

  it('accepts a list and passes when any one permission is held', async () => {
    signedInAs(currentUser(['dispatcher'], ['alert:ack']))
    renderApp('/dashboard', { children: gated(['alert:resolve', 'alert:ack']) })

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('with { all } needs every permission, so one of them is not enough', async () => {
    signedInAs(currentUser(['driver'], ['vehicle:read']))
    renderApp('/dashboard', { children: <div data-testid="slot">{gated({ all: ['vehicle:read', 'depot:read'] })}</div> })
    await screen.findByText('Sam Tester')
    expect(screen.getByTestId('slot')).toBeEmptyDOMElement()
  })

  it('with { all } passes when every permission is held', async () => {
    signedInAs(currentUser(['dispatcher'], ['vehicle:read', 'depot:read']))
    renderApp('/dashboard', { children: gated({ all: ['vehicle:read', 'depot:read'] }) })
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('checks permission codes, not role names', async () => {
    // A role called "admin" without the permission gets nothing.
    signedInAs(currentUser(['admin'], []))
    renderApp('/dashboard', { children: <div data-testid="slot">{gated('users:write')}</div> })

    await screen.findByText('Sam Tester')
    expect(screen.getByTestId('slot')).toBeEmptyDOMElement()
  })
})
