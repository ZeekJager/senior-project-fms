import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from './cn'

type Tone = 'success' | 'info' | 'danger'

interface ToastItem {
  id: number
  title: string
  description?: string
  tone: Tone
}

interface ToastApi {
  toast(message: { title: string; description?: string; tone?: Tone }): void
}

const ToastContext = createContext<ToastApi | null>(null)

const VISIBLE_MS = 4500

const ICONS: Record<Tone, ReactNode> = {
  success: <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />,
  info: <Info className="h-5 w-5 text-info" aria-hidden="true" />,
  danger: <XCircle className="h-5 w-5 text-danger" aria-hidden="true" />,
}

/**
 * Confirmations after an action ("Vehicle registered"). Errors that need the
 * user's attention belong next to what failed, not here. The live region is
 * always rendered so screen readers announce each toast.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((t) => t.id !== id)), [])

  const toast = useCallback<ToastApi['toast']>(({ title, description, tone = 'success' }) => {
    const id = nextId.current++
    setItems((current) => [...current.slice(-2), { id, title, description, tone }])
  }, [])

  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6"
      >
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [item.id, onDismiss])

  return (
    <div
      className={cn(
        'pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-card border border-line',
        'bg-surface/90 p-4 shadow-elevated backdrop-blur-xl',
      )}
    >
      {ICONS[item.tone]}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{item.title}</p>
        {item.description && <p className="mt-0.5 text-sm text-ink-muted">{item.description}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(item.id)}
        className="focus-ring -m-1 rounded-md p-1 text-ink-subtle transition-colors hover:text-ink"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}

/** `toast({ title })` from anywhere under ToastProvider. Without a provider it does nothing. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { toast: () => {} }
}
