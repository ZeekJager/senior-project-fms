import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PasswordField } from './Field'

function Harness({ onSubmit = () => undefined }: { onSubmit?: () => void }) {
  const [value, setValue] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <PasswordField id="pw" label="Password" value={value} onChange={(e) => setValue(e.target.value)} />
    </form>
  )
}

describe('PasswordField', () => {
  it('starts hidden, with a button that says what it will do', () => {
    render(<Harness />)
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    const eye = screen.getByRole('button', { name: 'Show password' })
    expect(eye).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows what was typed when the eye is pressed, and hides it again; the text and the label stay', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(screen.getByLabelText('Password'), 'password1234')

    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Password')).toHaveValue('password1234')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Password')).toHaveValue('password1234')
  })

  it('works from the keyboard: the eye is next in the tab order, and Enter on it does not submit the form', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<Harness onSubmit={onSubmit} />)
    await user.click(screen.getByLabelText('Password'))
    await user.tab()
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.keyboard(' ')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the field’s own props: its error is announced, and it is still invalid', () => {
    render(<PasswordField id="pw" label="Password" error="Enter your password." onChange={() => undefined} value="" />)
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
  })
})
