import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SyntheticBadge, anySynthetic } from './SyntheticBadge'

// FMS-97: every synthetic EV record says so on screen; real ones do not.
describe('SyntheticBadge', () => {
  it('shows "Synthetic data" with an explanation for a synthetic record', () => {
    render(<SyntheticBadge source="synthetic" />)
    const badge = screen.getByText('Synthetic data')
    expect(badge.closest('[title]')?.getAttribute('title')).toMatch(/not measured on a real vehicle/)
  })

  it('shows nothing for a typed-in or provider record', () => {
    const { container: manual } = render(<SyntheticBadge source="manual" />)
    const { container: provider } = render(<SyntheticBadge source="provider" />)
    const { container: unknown } = render(<SyntheticBadge source={undefined} />)
    expect(manual.innerHTML + provider.innerHTML + unknown.innerHTML).toBe('')
  })

  it('anySynthetic: a screen of records badges itself when one of them is synthetic', () => {
    expect(anySynthetic([{ source: 'manual' }, { source: 'synthetic' }])).toBe(true)
    expect(anySynthetic([{ source: 'manual' }, { source: 'provider' }, {}])).toBe(false)
    expect(anySynthetic([])).toBe(false)
  })
})
