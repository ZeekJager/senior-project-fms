import { useEffect } from 'react'

/** Press "/" anywhere outside a field to jump to the screen's search box, as in most work tools. */
export function useSearchShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return
      const search = document.querySelector<HTMLInputElement>('main input[type="search"]')
      if (!search) return
      e.preventDefault()
      search.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
