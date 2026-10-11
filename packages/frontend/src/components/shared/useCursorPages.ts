import { useCallback, useState } from 'react'

/**
 * The cursors of the pages seen so far, for an API that pages by cursor
 * (GET /audit-logs, FMS-28): `cursor` to request now, `next(nextCursor)` and
 * `previous()` for DataTable's cursor pagination, `reset()` when filters
 * change (a cursor belongs to one set of filters).
 */
export function useCursorPages() {
  // stack[0] is the first page (no cursor); the last entry is the current page.
  const [stack, setStack] = useState<(string | null)[]>([null])
  const next = useCallback((cursor: string | null) => {
    if (cursor) setStack((s) => [...s, cursor])
  }, [])
  const previous = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), [])
  const reset = useCallback(() => setStack([null]), [])
  return { cursor: stack[stack.length - 1], pageIndex: stack.length, next, previous, reset }
}
