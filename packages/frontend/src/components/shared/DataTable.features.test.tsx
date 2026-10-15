import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTable, type Column } from './DataTable'

interface Row {
  id: string
  name: string
  depot: string
}

const rows: Row[] = [
  { id: 'a', name: 'Abebe', depot: 'Addis' },
  { id: 'b', name: 'Bekele', depot: 'Adama' },
  { id: 'c', name: 'Chaltu', depot: 'Hawassa' },
]

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', sortKey: 'name', cell: (r) => <button type="button">{r.name}</button> },
  { key: 'depot', header: 'Depot', sortKey: 'depot', optional: true, cell: (r) => r.depot },
]

const page = { page: 1, pageSize: 25, totalItems: 3, onPageChange: () => {} }

beforeEach(() => localStorage.clear())

describe('DataTable: clickable rows', () => {
  it('opens a row on click, but not when the click lands on the row’s own button', async () => {
    const onRowClick = vi.fn()
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} isLoading={false} onRowClick={onRowClick} pagination={page} />)
    await userEvent.click(screen.getByText('Hawassa'))
    expect(onRowClick).toHaveBeenCalledWith(rows[2])
    onRowClick.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Abebe' }))
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('moves through the rows with J and K, opens the marked row with Enter, and Escape lets go', async () => {
    const onRowClick = vi.fn()
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} rowLabel={(r) => r.name} isLoading={false} onRowClick={onRowClick} pagination={page} />)
    const user = userEvent.setup()
    await user.keyboard('j')
    await user.keyboard('j')
    expect(screen.getByText(/Row 2 of 3: Bekele/)).toBeInTheDocument()
    await user.keyboard('k')
    expect(screen.getByText(/Row 1 of 3: Abebe/)).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenCalledWith(rows[0])
    await user.keyboard('{Escape}')
    expect(screen.queryByText(/Row 1 of 3/)).not.toBeInTheDocument()
  })

  it('leaves J and K alone while typing in a field', async () => {
    const onRowClick = vi.fn()
    render(
      <>
        <input aria-label="Search" />
        <DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} rowLabel={(r) => r.name} isLoading={false} onRowClick={onRowClick} pagination={page} />
      </>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'Search' }))
    await user.keyboard('jk')
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue('jk')
    expect(screen.queryByText(/Row \d of 3/)).not.toBeInTheDocument()
  })

  it('does not capture keys when no row can be opened', async () => {
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} rowLabel={(r) => r.name} isLoading={false} pagination={page} />)
    await userEvent.keyboard('j')
    expect(screen.queryByText(/Row \d of 3/)).not.toBeInTheDocument()
  })

  it('tints a row that needs attention', () => {
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} rowClassName={(r) => (r.id === 'b' ? 'bg-warning-soft/30' : undefined)} isLoading={false} pagination={page} />)
    expect(screen.getByText('Bekele').closest('tr')).toHaveClass('bg-warning-soft/30')
    expect(screen.getByText('Abebe').closest('tr')).not.toHaveClass('bg-warning-soft/30')
  })
})

describe('DataTable: selection', () => {
  function Selectable() {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
    return (
      <>
        <p data-testid="count">{selected.size}</p>
        <DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} rowLabel={(r) => r.name} isLoading={false} pagination={page} selection={{ selected, onChange: setSelected }} />
      </>
    )
  }

  it('ticks single rows, all rows, and shows a mixed state', async () => {
    render(<Selectable />)
    const user = userEvent.setup()
    const all = screen.getByRole('checkbox', { name: 'Select every row on this page' })
    await user.click(screen.getByRole('checkbox', { name: 'Select Abebe' }))
    expect(screen.getByTestId('count')).toHaveTextContent('1')
    expect((all as HTMLInputElement).indeterminate).toBe(true)
    await user.click(all)
    expect(screen.getByTestId('count')).toHaveTextContent('3')
    expect(all).toBeChecked()
    await user.click(all)
    expect(screen.getByTestId('count')).toHaveTextContent('0')
  })
})

describe('DataTable: table options', () => {
  it('compact rows are shorter, and the choice is remembered', async () => {
    const view = render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} isLoading={false} tableId="people" pagination={page} />)
    expect(screen.getByText('Bekele').closest('tr')).toHaveClass('h-14')
    await userEvent.click(screen.getByRole('button', { name: 'Table options' }))
    await userEvent.click(screen.getByRole('button', { name: 'compact' }))
    expect(screen.getByText('Bekele').closest('tr')).toHaveClass('h-11')
    view.unmount()
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} isLoading={false} tableId="people" pagination={page} />)
    expect(screen.getByText('Bekele').closest('tr')).toHaveClass('h-11')
  })

  it('hides an optional column and remembers it; a required column cannot be hidden', async () => {
    const view = render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} isLoading={false} tableId="people" pagination={page} />)
    expect(screen.getByRole('columnheader', { name: /Depot/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Table options' }))
    const panel = screen.getByRole('group', { name: 'Table options' })
    expect(within(panel).queryByRole('checkbox', { name: 'Name' })).not.toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Depot' }))
    expect(screen.queryByRole('columnheader', { name: /Depot/ })).not.toBeInTheDocument()
    view.unmount()
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} isLoading={false} tableId="people" pagination={page} />)
    expect(screen.queryByRole('columnheader', { name: /Depot/ })).not.toBeInTheDocument()
  })

  it('has no options without a tableId', () => {
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} isLoading={false} pagination={page} />)
    expect(screen.queryByRole('button', { name: 'Table options' })).not.toBeInTheDocument()
  })

  it('Escape closes the options and returns focus to the button', async () => {
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} isLoading={false} tableId="people" pagination={page} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Table options' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Table options' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Table options' })).toHaveFocus()
  })
})

describe('DataTable: one page and a second sort', () => {
  it('one page shows only the count: no arrows and no "Page 1 of 1"', () => {
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} isLoading={false} pagination={page} />)
    const nav = screen.getByRole('navigation', { name: 'Pagination' })
    expect(nav).toHaveTextContent('1–3 of 3')
    expect(within(nav).queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument()
    expect(within(nav).queryByText(/Page 1 of 1/)).not.toBeInTheDocument()
  })

  it('Shift+click on a header asks for a second sort; a plain click changes the first', async () => {
    const onChange = vi.fn()
    const onThen = vi.fn()
    render(<DataTable caption="People" columns={columns} data={rows} rowKey={(r) => r.id} isLoading={false} pagination={page} sort={{ key: 'name', order: 'asc', onChange, onThen, then: { key: 'depot', order: 'desc' } }} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Depot/ }))
    expect(onChange).toHaveBeenCalledWith('depot')
    await user.keyboard('{Shift>}')
    await user.click(screen.getByRole('button', { name: /^Depot/ }))
    await user.keyboard('{/Shift}')
    expect(onThen).toHaveBeenCalledWith('depot')
    expect(screen.getByText(/second sort, descending/)).toBeInTheDocument()
  })
})
