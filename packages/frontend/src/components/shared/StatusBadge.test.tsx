import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { STATUSES, STATUS_STYLES, StatusBadge, type Status } from './StatusBadge'

describe('StatusBadge colour vocabulary', () => {
  // A new status has to be added to this snapshot to pass: it cannot reach a
  // screen without a reviewed colour. (The compiler also rejects it: the style
  // table is a Record over every status.)
  it('maps every status to one colour', () => {
    expect(Object.fromEntries(STATUSES.map((status) => [status, STATUS_STYLES[status].colour]))).toMatchInlineSnapshot(`
      {
        "assigned": "blue",
        "cancelled": "red",
        "completed": "green",
        "draft": "grey",
        "en_route": "yellow",
        "flagged": "orange",
        "scheduled": "grey",
      }
    `)
  })

  it('has a style, a label and classes for every status, and none for anything else', () => {
    expect(Object.keys(STATUS_STYLES).sort()).toEqual([...STATUSES].sort())
    for (const status of STATUSES) {
      expect(STATUS_STYLES[status].label).not.toBe('')
      expect(STATUS_STYLES[status].classes).toMatch(/bg-\w+-\d+ text-\w+-\d+/)
    }
  })

  it('renders the colour classes for each status', () => {
    const { container } = render(
      <>
        {STATUSES.map((status) => (
          <StatusBadge key={status} status={status} />
        ))}
      </>,
    )
    expect(container).toMatchSnapshot()
  })

  it('shows the label as text, so colour is never the only signal', () => {
    render(<StatusBadge status="en_route" />)
    expect(screen.getByText('En route')).toHaveClass('bg-yellow-100')
  })

  it('does not accept a status without a colour entry (compile-time)', () => {
    // @ts-expect-error 'parked' is not in STATUSES, so it has no colour.
    const unknown: Status = 'parked'
    expect(STATUS_STYLES[unknown]).toBeUndefined()
  })
})
