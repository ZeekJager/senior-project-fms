import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
