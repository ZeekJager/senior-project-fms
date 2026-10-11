import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderApp, signedOut } from '@/test/auth'

describe('/dev/ui examples page', () => {
  it('is reachable without signing in and shows each shared component', async () => {
    signedOut()
    renderApp('/dev/ui')

    expect(await screen.findByRole('heading', { name: 'Shared UI examples' })).toBeInTheDocument()
    expect(screen.getByText('ETB 149.99')).toBeInTheDocument()
    expect(screen.getByText('23.50 L')).toBeInTheDocument()
    expect(screen.getByText('En route')).toBeInTheDocument()
    expect(screen.getByLabelText('Price')).toHaveValue('149.99')
    expect(screen.getByTestId('location')).toHaveTextContent('/dev/ui')
  })

  it('shows the table, error boundary and type-to-confirm examples working', async () => {
    signedOut()
    renderApp('/dev/ui')
    const user = userEvent.setup()
    const paging = await screen.findByRole('table', { name: 'Paging example' })
    expect(paging).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('AA 3-10006')).toBeInTheDocument()

    vi.spyOn(console, 'error').mockImplementation(() => {})
    await user.click(screen.getByRole('button', { name: 'Throw a render error' }))
    expect(screen.getByText('7f3c2a10-5b1e-4c8e-9d2a-3e4f5a6b7c8d')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Try again' }).at(-1)!)
    expect(screen.getByRole('button', { name: 'Throw a render error' })).toBeInTheDocument()
    vi.mocked(console.error).mockRestore()

    await user.click(screen.getByRole('button', { name: 'Type-to-confirm: DELETE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete 23 archived records?' })
    expect(within(dialog).getByRole('button', { name: 'Delete records' })).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type DELETE to confirm'), 'DELETE')
    expect(within(dialog).getByRole('button', { name: 'Delete records' })).toBeEnabled()
  })
})
