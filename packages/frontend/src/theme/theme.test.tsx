import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { THEME_KEY, setTheme } from './theme'

function systemPrefersDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: dark && query.includes('dark'), media: query, addEventListener() {}, removeEventListener() {} }))
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('starts from the system setting when nothing is stored', () => {
    systemPrefersDark(true)
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
  })

  it('starts light when the system is light', () => {
    systemPrefersDark(false)
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
  })

  it('a stored choice beats the system setting', () => {
    systemPrefersDark(true)
    localStorage.setItem(THEME_KEY, 'light')
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
  })

  it('switches the theme, marks the page and remembers the choice', async () => {
    systemPrefersDark(false)
    render(<ThemeToggle />)
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
  })

  it('keeps every toggle on the page in step', async () => {
    systemPrefersDark(false)
    render(
      <>
        <ThemeToggle />
        <ThemeToggle />
      </>,
    )
    await userEvent.click(screen.getAllByRole('button', { name: 'Switch to dark theme' })[0])
    expect(screen.getAllByRole('button', { name: 'Switch to light theme' })).toHaveLength(2)
  })

  it('still switches when storage is blocked', async () => {
    systemPrefersDark(false)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<ThemeToggle />)
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    vi.restoreAllMocks()
  })

  it('setTheme applies a theme without a toggle', () => {
    setTheme('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })
})
