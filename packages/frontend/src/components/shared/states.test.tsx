import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/errors'
import { ConfirmDialog } from './ConfirmDialog'
import { DataTable, type Column } from './DataTable'
import { ErrorBoundary } from './ErrorBoundary'

interface Row {
  id: string
  name: string
}
const columns: Column<Row>[] = [{ key: 'name', header: 'Name', cell: (r) => r.name }]

describe('DataTable', () => {
  it('loading skeleton rows have the same height class as data rows, so nothing shifts', () => {
    const { rerender } = render(<DataTable caption="People" columns={columns} data={undefined} rowKey={(r) => r.id} isLoading />)
    const skeletons = screen.getAllByTestId('skeleton-row')
    expect(skeletons.length).toBeGreaterThan(0)
    const skeletonHeight = [...skeletons[0].classList].find((c) => /^h-\d+$/.test(c))

    rerender(<DataTable caption="People" columns={columns} data={[{ id: '1', name: 'Abebe' }]} rowKey={(r) => r.id} isLoading={false} />)
    const row = screen.getByText('Abebe').closest('tr')!
    expect(skeletonHeight).toBeDefined()
    expect(row).toHaveClass(skeletonHeight!)
    expect(screen.queryByTestId('skeleton-row')).not.toBeInTheDocument()
  })

  it('shows the empty state instead of rows, and an error with its correlation id and a retry', async () => {
    const { rerender } = render(
      <DataTable caption="People" columns={columns} data={[]} rowKey={(r) => r.id} isLoading={false} emptyState={<p>Nobody yet</p>} />,
    )
    expect(screen.getByText('Nobody yet')).toBeInTheDocument()

    const retry = vi.fn()
    rerender(
      <DataTable
        caption="People"
        columns={columns}
        data={undefined}
        rowKey={(r) => r.id}
        isLoading={false}
        error={new ApiError(503, 'SERVICE_UNAVAILABLE', 'down', [], 'req-7')}
        onRetry={retry}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('SERVICE_UNAVAILABLE')).toBeInTheDocument()
    expect(within(alert).getByText('req-7')).toBeInTheDocument()
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('pages: shows the range and disables the ends', async () => {
    const onPageChange = vi.fn()
    render(
      <DataTable
        caption="People"
        columns={columns}
        data={[{ id: '1', name: 'Abebe' }]}
        rowKey={(r) => r.id}
        isLoading={false}
        pagination={{ page: 1, pageSize: 25, totalItems: 60, onPageChange }}
      />,
    )
    const nav = screen.getByRole('navigation', { name: 'Pagination' })
    expect(nav).toHaveTextContent('1–25 of 60')
    expect(within(nav).getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await userEvent.click(within(nav).getByRole('button', { name: 'Next page' }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('sortable headers announce their order', () => {
    render(
      <DataTable
        caption="People"
        columns={[{ ...columns[0], sortKey: 'name' }]}
        data={[]}
        rowKey={(r) => r.id}
        isLoading={false}
        sort={{ key: 'name', order: 'desc', onChange: () => {} }}
      />,
    )
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'descending')
  })
})

describe('ConfirmDialog', () => {
  it('with requireTyping="DELETE" keeps confirm disabled until DELETE is typed exactly', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(<ConfirmDialog open onClose={() => {}} title="Delete" message="Gone for good." action="Delete" requireTyping="DELETE" onConfirm={onConfirm} />)
    const confirm = screen.getByRole('button', { name: 'Delete' })
    const input = screen.getByLabelText('Type DELETE to confirm')
    expect(input).toHaveFocus()

    expect(confirm).toBeDisabled()
    await user.type(input, 'delete')
    expect(confirm).toBeDisabled()
    await user.clear(input)
    await user.type(input, 'DELETE ')
    expect(confirm).toBeDisabled()
    await user.type(input, '{Backspace}')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('closes on Escape and shows an error inline', async () => {
    const onClose = vi.fn()
    render(<ConfirmDialog open onClose={onClose} title="Retire" message="Sure?" action="Retire" onConfirm={() => {}} error="It is in use." />)
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('It is in use.')
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('ErrorBoundary', () => {
  function Boom(): never {
    throw new ApiError(500, 'INTERNAL_SERVER_ERROR', 'boom', [], 'corr-123')
  }

  it('shows the error code and the correlation id instead of a blank screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('INTERNAL_SERVER_ERROR')
    expect(screen.getByText('corr-123')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy error details' })).toBeInTheDocument()
    vi.mocked(console.error).mockRestore()
  })
})
