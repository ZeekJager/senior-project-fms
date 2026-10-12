import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/errors'
import { ConfirmDialog } from './ConfirmDialog'
import { DataTable, type Column } from './DataTable'
import { ErrorBoundary } from './ErrorBoundary'
import { useCursorPages } from './useCursorPages'

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

  it('rowHeight="stacked" gives real and loading rows the same taller height on phones', () => {
    const { rerender } = render(<DataTable caption="People" columns={columns} data={undefined} rowKey={(r) => r.id} isLoading rowHeight="stacked" />)
    expect(screen.getAllByTestId('skeleton-row')[0]).toHaveClass('h-[72px]', 'sm:h-14')
    rerender(<DataTable caption="People" columns={columns} data={[{ id: '1', name: 'Abebe' }]} rowKey={(r) => r.id} isLoading={false} rowHeight="stacked" />)
    expect(screen.getByText('Abebe').closest('tr')).toHaveClass('h-[72px]', 'sm:h-14')
  })

  it('warns in development when data rows come out taller than the loading rows (the page would jump)', () => {
    // jsdom has no layout: loading rows measure 64px, data rows 67px.
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { height: this.getAttribute('data-testid') === 'skeleton-row' ? 64 : 67 } as DOMRect
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { rerender } = render(<DataTable caption="People" columns={columns} data={undefined} rowKey={(r) => r.id} isLoading />)
    expect(warn).not.toHaveBeenCalled()
    rerender(<DataTable caption="People" columns={columns} data={[{ id: '1', name: 'Abebe' }]} rowKey={(r) => r.id} isLoading={false} />)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DataTable "People": rows are up to 67px, taller than the 64px loading rows/))
    rect.mockRestore()
    warn.mockRestore()
  })

  it('tells screen readers what changed: loading, the rows shown, or nothing', () => {
    const pagination = { page: 2, pageSize: 2, totalItems: 5, onPageChange: () => {} }
    const { rerender } = render(<DataTable caption="People" columns={columns} data={undefined} rowKey={(r) => r.id} isLoading pagination={pagination} />)
    const status = screen.getByTestId('table-status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('Loading people…')
    rerender(<DataTable caption="People" columns={columns} data={[{ id: '3', name: 'Almaz' }, { id: '4', name: 'Bekele' }]} rowKey={(r) => r.id} isLoading={false} pagination={pagination} />)
    expect(screen.getByTestId('table-status')).toBe(status)
    expect(status).toHaveTextContent('People: 3–4 of 5.')
    rerender(<DataTable caption="People" columns={columns} data={[]} rowKey={(r) => r.id} isLoading={false} />)
    expect(status).toHaveTextContent('People: nothing to show.')
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

describe('DataTable cursor paging', () => {
  // A fake cursor API over 5 rows, 2 per page: the cursor is the index to start from.
  const all = ['Abebe', 'Almaz', 'Bekele', 'Dawit', 'Eden'].map((name, i) => ({ id: String(i), name }))
  const fetchPage = (cursor: string | null) => {
    const start = cursor ? Number(cursor) : 0
    return { rows: all.slice(start, start + 2), nextCursor: start + 2 < all.length ? String(start + 2) : null }
  }

  function AuditLike({ filter }: { filter: string }) {
    const pages = useCursorPages()
    const [lastFilter, setLastFilter] = useState(filter)
    if (filter !== lastFilter) {
      setLastFilter(filter)
      pages.reset()
    }
    const { rows, nextCursor } = fetchPage(pages.cursor)
    return (
      <DataTable
        caption="Trail"
        columns={columns}
        data={rows}
        rowKey={(r) => r.id}
        isLoading={false}
        pagination={{ kind: 'cursor', pageIndex: pages.pageIndex, pageSize: 2, hasNext: nextCursor !== null, onNext: () => pages.next(nextCursor), onPrevious: pages.previous }}
      />
    )
  }

  it('pages forward and back with no total; previous is off on the first page, next on the last; new filters start over', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<AuditLike filter="a" />)
    const nav = screen.getByRole('navigation', { name: 'Pagination' })
    expect(nav).toHaveTextContent('1–2 · more after')
    expect(within(nav).getByRole('button', { name: 'Previous page' })).toBeDisabled()

    await user.click(within(nav).getByRole('button', { name: 'Next page' }))
    await user.click(within(nav).getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('Eden')).toBeInTheDocument()
    expect(nav).toHaveTextContent('5–5')
    expect(nav).not.toHaveTextContent('more after')
    expect(within(nav).getByRole('button', { name: 'Next page' })).toBeDisabled()
    expect(screen.getByTestId('table-status')).toHaveTextContent('Trail: 5–5.')

    await user.click(within(nav).getByRole('button', { name: 'Previous page' }))
    expect(screen.getByText('Bekele')).toBeInTheDocument()
    expect(nav).toHaveTextContent('3–4 · more after')

    rerender(<AuditLike filter="b" />)
    expect(screen.getByText('Abebe')).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Pagination' })).getByRole('button', { name: 'Previous page' })).toBeDisabled()
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
    expect(screen.getByText(/Not a match yet: type DELETE exactly/)).toBeInTheDocument()
    await user.type(input, '{Backspace}')
    expect(confirm).toBeEnabled()
    expect(screen.queryByText(/Not a match yet/)).not.toBeInTheDocument()
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

  it('copies the code and request id for support, and says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // user-event provides the clipboard; read back what the button wrote.
    const user = userEvent.setup()
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    await user.click(screen.getByRole('button', { name: 'Copy error details' }))
    const copied = await navigator.clipboard.readText()
    expect(copied).toContain('Error: INTERNAL_SERVER_ERROR')
    expect(copied).toContain('Request ID: corr-123')
    expect(screen.getByText('Error details copied.')).toBeInTheDocument()
    vi.mocked(console.error).mockRestore()
  })

  it('"Try again" runs onReset first, then renders the children again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let broken = true
    function Flaky() {
      if (broken) throw new Error('first render fails')
      return <p>Recovered</p>
    }
    render(
      <ErrorBoundary onReset={() => (broken = false)}>
        <Flaky />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Error')
    await act(() => userEvent.setup().click(screen.getByRole('button', { name: 'Try again' })))
    expect(screen.getByText('Recovered')).toBeInTheDocument()
    vi.mocked(console.error).mockRestore()
  })
})
