import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './Button'
import { cn } from './cn'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * While `active`: moves focus into the container (to `initialFocus`, else the
 * first focusable element), keeps Tab and Shift+Tab inside it, locks page
 * scroll, and on close gives focus back to whatever had it before.
 */
function useModalBehaviour(container: RefObject<HTMLElement | null>, active: boolean, initialFocus?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = container.current
    if (!active || !node) return
    const previous = document.activeElement as HTMLElement | null
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
    ;(initialFocus?.current ?? focusables()[0] ?? node).focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    node.addEventListener('keydown', onKeyDown)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [active, container, initialFocus])
}

type Placement = 'center' | 'right' | 'left'

const PANEL: Record<Placement, string> = {
  center:
    'relative m-4 w-full max-w-md animate-scale-in rounded-sheet border border-line bg-surface shadow-elevated sm:m-0',
  // Floating sheets inset 8px from the edges, the modern "card drawer".
  right:
    'fixed inset-y-2 right-2 flex w-[calc(100vw-16px)] max-w-[480px] animate-slide-in-right flex-col rounded-sheet border border-line bg-surface shadow-elevated',
  left: 'fixed inset-y-2 left-2 flex w-[min(320px,calc(100vw-16px))] animate-slide-in-left flex-col rounded-sheet border border-line bg-surface shadow-elevated',
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  placement: Placement
  initialFocus?: RefObject<HTMLElement | null>
  /** Sticky actions under the scrolling body (drawers). */
  footer?: ReactNode
  /** Visually hide the title (still the dialog's accessible name). */
  hideTitle?: boolean
  className?: string
}

function Modal({ open, onClose, title, description, children, placement, initialFocus, footer, hideTitle, className }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useModalBehaviour(panel, open, initialFocus)

  // Escape closes from anywhere, even after focus has left the panel (a
  // button that turns busy loses focus). A menu inside that handles Escape
  // itself stops the event first.
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!open) return null

  return createPortal(
    <div className={cn('fixed inset-0 z-50', placement === 'center' && 'flex items-center justify-center')}>
      <div
        className="fixed inset-0 animate-fade-in bg-overlay/40 backdrop-blur-[3px]"
        aria-hidden="true"
        onMouseDown={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(PANEL[placement], 'outline-none', className)}
      >
        <header className={cn('flex items-start justify-between gap-4', placement === 'center' ? 'px-6 pt-6' : 'border-b border-line px-6 py-5')}>
          <div className="min-w-0">
            <h2 id={titleId} className={cn('text-base font-semibold tracking-tight text-ink', hideTitle && 'sr-only')}>
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-sm text-ink-muted">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close" icon={<X />} size="sm" onClick={onClose} className="-mr-2 -mt-1 shrink-0" />
        </header>
        <div className={cn(placement === 'center' ? 'px-6 pb-6 pt-4' : 'min-h-0 flex-1 overflow-y-auto px-6 py-6')}>{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-muted/60 px-6 py-4 rounded-b-sheet">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export type DialogProps = Omit<ModalProps, 'placement'>

/** A centred modal for short decisions. Escape, the backdrop and the close button all call `onClose`. */
export function Dialog(props: DialogProps) {
  return <Modal {...props} placement="center" />
}

export interface DrawerProps extends Omit<ModalProps, 'placement'> {
  side?: 'right' | 'left'
}

/** A sheet that slides in from the side for forms and detail, without leaving the page. */
export function Drawer({ side = 'right', ...props }: DrawerProps) {
  return <Modal {...props} placement={side} />
}
