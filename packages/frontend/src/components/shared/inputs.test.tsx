import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FuelInput } from './FuelInput'
import { MoneyInput } from './MoneyInput'

function Harness({
  Input,
  initial = null,
  required,
  spy,
}: {
  Input: typeof MoneyInput
  initial?: number | null
  required?: boolean
  spy?: (minor: number | null) => void
}) {
  const [value, setValue] = useState<number | null>(initial)
  return (
    <>
      <Input
        label="Amount"
        value={value}
        required={required}
        onChange={(next) => {
          spy?.(next)
          setValue(next)
        }}
      />
      <button type="button" onClick={() => setValue(500)}>
        Load 500
      </button>
    </>
  )
}

const field = () => screen.getByLabelText('Amount')

describe('MoneyInput', () => {
  it('accepts "149.99" and emits 14999', async () => {
    const spy = vi.fn()
    render(<Harness Input={MoneyInput} spy={spy} />)
    const user = userEvent.setup()

    await user.type(field(), '149.99')
    await user.tab()

    expect(spy).toHaveBeenLastCalledWith(14999)
    expect(field()).toHaveValue('149.99')
    expect(field()).not.toHaveAttribute('aria-invalid')
  })

  it('only ever emits integers or null, never a float', async () => {
    const spy = vi.fn()
    render(<Harness Input={MoneyInput} spy={spy} />)

    await userEvent.setup().type(field(), '149.99')

    for (const [emitted] of spy.mock.calls) {
      expect(emitted === null || Number.isInteger(emitted)).toBe(true)
    }
  })

  it('rejects "149.999" with an inline error and emits null', async () => {
    const spy = vi.fn()
    render(<Harness Input={MoneyInput} spy={spy} />)

    await userEvent.setup().type(field(), '149.999')

    expect(screen.getByText('Use at most 2 decimal places.')).toBeInTheDocument()
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(field()).toHaveAccessibleDescription(/Use at most 2 decimal places/)
    expect(spy).toHaveBeenLastCalledWith(null)
  })

  it('keeps the invalid text on blur instead of rounding it', async () => {
    render(<Harness Input={MoneyInput} />)
    const user = userEvent.setup()

    await user.type(field(), '149.999')
    await user.tab()

    expect(field()).toHaveValue('149.999')
    expect(screen.getByText('Use at most 2 decimal places.')).toBeInTheDocument()
  })

  it('clears the error once the text is valid again', async () => {
    render(<Harness Input={MoneyInput} />)
    const user = userEvent.setup()

    await user.type(field(), '149.999')
    await user.type(field(), '{Backspace}')

    expect(screen.queryByText('Use at most 2 decimal places.')).not.toBeInTheDocument()
    expect(field()).not.toHaveAttribute('aria-invalid')
  })

  it.each(['abc', '1e3', '-5', '1,5'])('rejects %j as a bad format', async (text) => {
    render(<Harness Input={MoneyInput} />)

    await userEvent.setup().type(field(), text)

    expect(screen.getByText('Enter an amount like 149.99.')).toBeInTheDocument()
  })

  it('pads to two decimals on blur', async () => {
    const spy = vi.fn()
    render(<Harness Input={MoneyInput} spy={spy} />)
    const user = userEvent.setup()

    await user.type(field(), '149.9')
    await user.tab()

    expect(field()).toHaveValue('149.90')
    expect(spy).toHaveBeenLastCalledWith(14990)
  })

  it('has the value ready for a form submitted with Enter, without a blur', async () => {
    const spy = vi.fn()
    render(<Harness Input={MoneyInput} spy={spy} />)
    const user = userEvent.setup()

    await user.type(field(), '20')
    await user.keyboard('{Enter}')

    expect(spy).toHaveBeenLastCalledWith(2000)
  })

  it('shows an initial value and follows later changes from the form', async () => {
    render(<Harness Input={MoneyInput} initial={14999} />)
    expect(field()).toHaveValue('149.99')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Load 500' }))
    expect(field()).toHaveValue('5.00')
  })

  it('shows a required error only after the field was visited', async () => {
    render(<Harness Input={MoneyInput} required />)
    expect(screen.queryByText('This field is required.')).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(field())
    await user.tab()

    expect(screen.getByText('This field is required.')).toBeInTheDocument()
  })

  it('shows an error handed in by the form', () => {
    render(<MoneyInput label="Amount" value={null} onChange={() => {}} error="Price is required for this vehicle." />)

    expect(screen.getByText('Price is required for this vehicle.')).toBeInTheDocument()
    expect(field()).toHaveAttribute('aria-invalid', 'true')
  })

  it('is labelled, and its error region exists before there is an error to announce', () => {
    render(<MoneyInput label="Amount" value={null} onChange={() => {}} />)

    expect(field()).toHaveAccessibleDescription(/^ETB, up to 2 decimal places\s*$/)
    expect(document.querySelector('[aria-live="polite"]')).toBeEmptyDOMElement()
  })
})

describe('FuelInput', () => {
  it('accepts "23.5" and emits 23500', async () => {
    const spy = vi.fn()
    render(<Harness Input={FuelInput} spy={spy} />)
    const user = userEvent.setup()

    await user.type(field(), '23.5')
    await user.tab()

    expect(spy).toHaveBeenLastCalledWith(23500)
    expect(field()).toHaveValue('23.500')
  })

  it('accepts three decimals and rejects a fourth', async () => {
    const spy = vi.fn()
    render(<Harness Input={FuelInput} spy={spy} />)
    const user = userEvent.setup()

    await user.type(field(), '0.001')
    expect(spy).toHaveBeenLastCalledWith(1)

    await user.type(field(), '9')
    expect(screen.getByText('Use at most 3 decimal places.')).toBeInTheDocument()
    expect(spy).toHaveBeenLastCalledWith(null)
  })
})
