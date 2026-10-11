import { AlertCircle, AlertTriangle, ArrowRight, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/shared'
import { Button, cn, Dialog, TextField, useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useAdjustStock, type Part } from './api'

const REASONS = {
  in: ['Delivery received', 'Returned from workshop', 'Stock take correction'],
  out: ['Damaged or expired', 'Stock take correction', 'Sent to another depot'],
} as const

type Direction = 'in' | 'out'

/**
 * Stock in or out outside a repair, with a reason (kept in the part's ledger).
 * Taking stock out asks for confirmation first (ConfirmDialog). The count on
 * screen may be stale, so a take-out that looks too big is warned about but
 * still sent: the server decides, and its 409 is shown here, inline.
 */
export function AdjustStockDialog({ part, onClose }: { part: Part | null; onClose: () => void }) {
  const adjust = useAdjustStock()
  const { toast } = useToast()
  const [direction, setDirection] = useState<Direction>('in')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const amountInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!part) return
    setDirection('in')
    setAmount('')
    setReason('')
    setErrors({})
    setServerError(null)
    setConfirming(false)
  }, [part])

  const count = /^\d{1,7}$/.test(amount.trim()) ? Number.parseInt(amount.trim(), 10) : null
  const quantity = count === null ? null : direction === 'in' ? count : -count
  const after = part && quantity !== null ? part.stock_quantity + quantity : null

  function validate(): boolean {
    const found: typeof errors = {}
    if (count === null || count < 1) found.amount = 'A whole number of parts, 1 or more.'
    if (reason.trim().length < 3) found.reason = 'Say why (at least 3 characters): it is kept in the stock history.'
    setErrors(found)
    return Object.keys(found).length === 0
  }

  async function send() {
    if (!part || quantity === null) return
    setServerError(null)
    try {
      const updated = await adjust.mutateAsync({ partId: part.id, quantity, reason: reason.trim() })
      toast({
        title: direction === 'in' ? 'Stock added' : 'Stock removed',
        description: `${part.name}: ${part.stock_quantity} → ${updated.stock_quantity} in stock.`,
      })
      onClose()
    } catch (err) {
      setConfirming(false)
      // The server's own words for a refusal (e.g. "Only 50 in stock: cannot take out 100.").
      if (err instanceof ApiError && err.code === 'CONFLICT_INSUFFICIENT_STOCK') setServerError(err.message)
      else setServerError(err instanceof ApiError ? `The stock could not be adjusted (${err.code}).` : 'Could not reach the server. Try again.')
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!validate()) return
    if (direction === 'out') setConfirming(true)
    else void send()
  }

  return (
    <>
      <Dialog open={part !== null && !confirming} onClose={onClose} title={`Adjust stock · ${part?.name ?? ''}`} description={part ? `${part.part_number} · ${part.stock_quantity} in stock now` : undefined} initialFocus={amountInput}>
        <form onSubmit={onSubmit} noValidate>
          <div role="radiogroup" aria-label="Direction" className="mb-4 grid grid-cols-2 gap-1 rounded-control bg-surface-sunken p-1">
            {(['in', 'out'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                onClick={() => {
                  setDirection(d)
                  setServerError(null)
                }}
                className={cn(
                  'focus-ring flex h-9 items-center justify-center gap-1.5 rounded-[10px] text-sm font-medium transition-all duration-200 ease-smooth',
                  direction === d ? 'bg-surface text-ink shadow-soft' : 'text-ink-muted hover:text-ink',
                )}
              >
                {d === 'in' ? <Plus className="h-4 w-4" aria-hidden="true" /> : <Minus className="h-4 w-4" aria-hidden="true" />}
                {d === 'in' ? 'Add stock' : 'Remove stock'}
              </button>
            ))}
          </div>

          <TextField
            ref={amountInput}
            label={direction === 'in' ? 'Quantity to add' : 'Quantity to remove'}
            inputMode="numeric"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value)
              setServerError(null)
            }}
            error={errors.amount}
            trailing={<span className="text-xs">parts</span>}
          />

          <fieldset>
            <legend className="mb-2 text-xs font-medium text-ink-subtle">Reason</legend>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {REASONS[direction].map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={reason === r}
                  onClick={() => setReason(r)}
                  className={cn(
                    'focus-ring h-8 rounded-full border px-3 text-xs font-medium transition-colors',
                    reason === r ? 'border-brand/40 bg-brand-soft text-brand-ink' : 'border-line-strong text-ink-muted hover:text-ink',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
            <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} maxLength={500} />
          </fieldset>

          {part && after !== null && (
            <div className={cn('mt-1 flex items-center justify-between rounded-control px-4 py-3 text-sm', after < 0 ? 'bg-warning-soft' : 'bg-surface-muted')}>
              <span className="text-ink-muted">Stock after</span>
              <span className="tabular flex items-center gap-2 font-semibold text-ink">
                {part.stock_quantity} <ArrowRight className="h-3.5 w-3.5 text-ink-subtle" aria-hidden="true" /> {after}
              </span>
            </div>
          )}
          {after !== null && after < 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-warning">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              That is more than the stock on record. The server checks the current count and will refuse it if it is still short.
            </p>
          )}

          <div role="alert" className={serverError ? 'mt-4' : undefined}>
            {serverError && (
              <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {serverError}
              </div>
            )}
          </div>

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={adjust.isPending && !confirming}>
              {direction === 'in' ? 'Add to stock' : 'Remove from stock…'}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={part !== null && confirming}
        onClose={() => setConfirming(false)}
        title={`Remove ${count ?? 0} × ${part?.name ?? ''}?`}
        action="Remove from stock"
        busy={adjust.isPending}
        message={
          <p>
            Stock goes from <strong className="text-ink">{part?.stock_quantity}</strong> to <strong className="text-ink">{after}</strong>. Reason: {reason.trim()}. The
            change is recorded in the part&apos;s history and the audit log.
          </p>
        }
        onConfirm={send}
      />
    </>
  )
}
