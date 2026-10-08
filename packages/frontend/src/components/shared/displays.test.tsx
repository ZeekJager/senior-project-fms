import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FuelDisplay } from './FuelDisplay'
import { MoneyDisplay } from './MoneyDisplay'

describe('FuelDisplay', () => {
  it('renders 23500 ml as 23.50 L', () => {
    render(<FuelDisplay amountMinorUnits={23500} />)
    expect(screen.getByText('23.50 L')).toBeInTheDocument()
  })

  it('shows every millilitre with 3 decimals', () => {
    render(<FuelDisplay amountMinorUnits={23505} decimals={3} />)
    expect(screen.getByText('23.505 L')).toBeInTheDocument()
  })

  it('is right-aligned with tabular digits', () => {
    render(<FuelDisplay amountMinorUnits={1} />)
    expect(screen.getByText('0.00 L')).toHaveClass('text-right', 'tabular-nums')
  })

  it.each([null, undefined, 23.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])('renders a dash for %s', (value) => {
    render(<FuelDisplay amountMinorUnits={value} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('MoneyDisplay', () => {
  it('renders integer cents with the currency and grouping', () => {
    render(<MoneyDisplay amountMinorUnits={123456789} />)
    expect(screen.getByText('ETB 1,234,567.89')).toBeInTheDocument()
  })

  it('renders 14999 as 149.99, never a float artefact', () => {
    render(<MoneyDisplay amountMinorUnits={14999} />)
    expect(screen.getByText('ETB 149.99')).toBeInTheDocument()
  })

  it('renders zero and negative amounts', () => {
    render(
      <>
        <MoneyDisplay amountMinorUnits={0} />
        <MoneyDisplay amountMinorUnits={-250} />
      </>,
    )
    expect(screen.getByText('ETB 0.00')).toBeInTheDocument()
    expect(screen.getByText('ETB -2.50')).toBeInTheDocument()
  })

  it('refuses a float: 149.99 passed as money renders a dash, not a plausible amount', () => {
    render(<MoneyDisplay amountMinorUnits={149.99} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('is right-aligned', () => {
    render(<MoneyDisplay amountMinorUnits={100} />)
    expect(screen.getByText('ETB 1.00')).toHaveClass('text-right', 'tabular-nums')
  })
})
