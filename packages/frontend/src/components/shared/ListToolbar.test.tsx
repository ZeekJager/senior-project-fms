import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ListToolbar } from './ListToolbar'

const options = [
  { value: 'all', label: 'All', count: 24 },
  { value: 'active', label: 'Active', count: 20 },
  { value: 'flagged', label: 'Flagged', count: 4, hint: 'Needs maintenance' },
] as const

function setup(overrides: Partial<Parameters<typeof ListToolbar>[0]> = {}) {
  const onChange = vi.fn()
  const onSearch = vi.fn()
  render(
    <ListToolbar
      views={{ label: 'Views', value: 'all', options: [...options], onChange }}
      search={{ label: 'Search things', placeholder: 'Find', value: '', onChange: onSearch }}
      {...overrides}
    >
      <button type="button">Depot</button>
    </ListToolbar>,
  )
  return { onChange, onSearch }
}

describe('ListToolbar', () => {
  it('shows views with counts, marks the current one, and passes extra filters through', () => {
    setup()
    const views = screen.getByRole('group', { name: 'Views' })
    expect(within(views).getByRole('button', { name: 'All 24' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(views).getByRole('button', { name: 'Flagged 4' })).toHaveAttribute('title', 'Needs maintenance')
    expect(screen.getByRole('button', { name: 'Depot' })).toBeInTheDocument()
  })

  it('reports a chosen view and typed search', async () => {
    const { onChange, onSearch } = setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Flagged/ }))
    expect(onChange).toHaveBeenCalledWith('flagged')
    await user.type(screen.getByRole('searchbox', { name: 'Search things' }), 'a')
    expect(onSearch).toHaveBeenCalledWith('a')
  })

  it('hints at the "/" shortcut while the search is empty, and the field announces it', () => {
    setup()
    expect(screen.getByRole('searchbox', { name: 'Search things' })).toHaveAttribute('aria-keyshortcuts', '/')
    expect(screen.getByText('/')).toBeInTheDocument()
  })

  it('drops the hint once something is typed', () => {
    setup({ search: { label: 'Search things', placeholder: 'Find', value: 'abc', onChange: () => {} } })
    expect(screen.queryByText('/')).not.toBeInTheDocument()
  })

  it('offers Clear only when there is something to clear, and runs it', async () => {
    const onClear = vi.fn()
    setup({ onClear })
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledOnce()
  })

  it('has no Clear button when nothing is applied', () => {
    setup()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })

  it('works without a search box (the repair log filters by vehicle instead)', () => {
    setup({ search: undefined })
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Views' })).toBeInTheDocument()
  })

  it('marks no view when the current filters match none of them', () => {
    setup({ views: { label: 'Views', value: null, options: [...options], onChange: () => {} } })
    for (const b of within(screen.getByRole('group', { name: 'Views' })).getAllByRole('button')) expect(b).toHaveAttribute('aria-pressed', 'false')
  })

  it('reads a view hint out to screen readers, not only on hover', () => {
    setup()
    const flagged = screen.getByRole('button', { name: 'Flagged 4' })
    expect(flagged).toHaveAccessibleDescription('Needs maintenance')
  })

  it('puts archived views after a divider', () => {
    setup({
      views: {
        label: 'Views',
        value: 'all',
        options: [...options, { value: 'retired', label: 'Retired', archived: true }],
        onChange: () => {},
      },
    })
    const group = screen.getByRole('group', { name: 'Views' })
    expect(within(group).getByRole('separator')).toBeInTheDocument()
    const names = within(group).getAllByRole('button').map((b) => b.textContent?.trim())
    expect(names.at(-1)).toBe('Retired')
  })
})
