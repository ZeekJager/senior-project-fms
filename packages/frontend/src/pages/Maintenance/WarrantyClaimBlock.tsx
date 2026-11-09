import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MoneyDisplay, MoneyInput } from '@/components/shared'
import { Badge, Button, TextField, useToast } from '@/components/ui'
import { CLAIM_LABELS, CLAIM_NEXT, CLAIM_TONES, coverName, useUpdateClaim, type ClaimStatus, type WarrantyClaim } from '@/features/warranty'
import { ApiError } from '@/lib/api/errors'

const KM = /^\d{1,8}(\.\d)?$/
const km = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} km`

const ACTIONS: Record<Exclude<ClaimStatus, 'claimable'>, string> = {
  submitted: 'Submit claim',
  approved: 'Approved',
  rejected: 'Rejected',
}

/**
 * The warranty claim on a repair (FMS-133): which warranty covered it, and where the claim is. With
 * maintenance:write the claim moves on: submitted (with the provider's reference), then approved with the
 * amount recovered, or rejected (and sent again). Under a warranty that ends at an odometer reading, a repair
 * with no reading is submitted with the odometer at the repair, which is recorded on it and judged first.
 */
export function WarrantyClaimBlock({ recordId, claim: initial, canWrite }: { recordId: string; claim: WarrantyClaim; canWrite: boolean }) {
  const update = useUpdateClaim()
  const { toast } = useToast()
  const [claim, setClaim] = useState(initial)
  const [reference, setReference] = useState(initial.reference ?? '')
  const [amount, setAmount] = useState<number | null>(null)
  const [approving, setApproving] = useState(false)
  const [odometer, setOdometer] = useState('')
  const [odometerError, setOdometerError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setClaim(initial)
    setReference(initial.reference ?? '')
    setAmount(null)
    setApproving(false)
    setOdometer('')
    setOdometerError(null)
    setError(null)
  }, [recordId, initial])

  /** The reading this submit must carry: the repair has none and the warranty ends at one. */
  const needsOdometer = !claim.km_checked && claim.ends_km !== null

  async function move(status: Exclude<ClaimStatus, 'claimable'>) {
    if (status === 'approved' && !approving) return setApproving(true)
    if (status === 'approved' && (amount === null || amount < 0)) return setError('Enter the amount the provider pays back.')
    const reading = odometer.trim().replace(/,/g, '')
    const sendsOdometer = status === 'submitted' && needsOdometer
    if (sendsOdometer && (!KM.test(reading) || Number(reading) <= 0)) {
      return setOdometerError(reading ? 'An odometer reading in kilometres, e.g. 95000.' : 'Enter the odometer at the repair: the provider pays only within the limit.')
    }
    setError(null)
    setOdometerError(null)
    try {
      const next = await update.mutateAsync({
        recordId,
        status,
        ...(status === 'approved' ? { amount_cents: amount! } : {}),
        ...(status === 'submitted' ? { reference: reference.trim() || null } : {}),
        ...(sendsOdometer ? { odometer_km: Number(reading) } : {}),
      })
      setClaim(next)
      setApproving(false)
      toast({ title: CLAIM_LABELS[next.status], description: `Under the ${coverName(next).toLowerCase()} warranty from ${next.provider}.` })
    } catch (err) {
      const reason = err instanceof ApiError ? err.details[0]?.reason : undefined
      // The reading is kept on the repair: past the limit it is no longer claimable, and the record is read again.
      if (reason === 'over_km_limit') return setError(`At ${km(Number(reading))} the repair is past the warranty's ${km(claim.ends_km ?? 0)} limit: there is nothing to claim.`)
      if (reason === 'odometer_required') return setOdometerError('Enter the odometer at the repair: the provider pays only within the limit.')
      if (reason === 'odometer_recorded') return setError('The repair has its odometer reading now. Close it and open it again.')
      setError(
        err instanceof ApiError
          ? err.code === 'CONFLICT_INVALID_STATE_TRANSITION'
            ? 'The claim has moved on since this was opened. Close it and open it again.'
            : `The claim could not be updated (${err.code}).`
          : 'Could not reach the server. Try again.',
      )
    }
  }

  const next = canWrite ? CLAIM_NEXT[claim.status] : []
  return (
    <div className="space-y-3 rounded-control border border-brand/25 bg-brand-soft/40 px-3.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex items-start gap-2 text-sm text-ink">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-ink" aria-hidden="true" />
          <span>
            Covered by the <strong className="font-medium">{coverName(claim).toLowerCase()}</strong> warranty from {claim.provider}.
            {needsOdometer && (
              <span className="block text-xs text-warning">
                It ends at {km(claim.ends_km!)} and this repair has no odometer reading: the distance is not checked yet.
              </span>
            )}
          </span>
        </p>
        <Badge tone={CLAIM_TONES[claim.status]}>{CLAIM_LABELS[claim.status]}</Badge>
      </div>
      {(claim.reference || claim.amount_cents !== null) && (
        <p className="text-sm text-ink-muted">
          {claim.reference && <span>Reference {claim.reference}</span>}
          {claim.reference && claim.amount_cents !== null && ' · '}
          {claim.amount_cents !== null && (
            <span>
              Recovered <MoneyDisplay amountMinorUnits={claim.amount_cents} className="inline" />
            </span>
          )}
        </p>
      )}
      {next.includes('submitted') && (
        <TextField label="Provider's claim reference" optional value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} autoComplete="off" />
      )}
      {next.includes('submitted') && needsOdometer && (
        <TextField
          label="Odometer at the repair"
          inputMode="decimal"
          value={odometer}
          onChange={(e) => {
            setOdometer(e.target.value)
            setOdometerError(null)
          }}
          error={odometerError ?? undefined}
          hint="Recorded on the repair. Needed to submit: the provider pays only within the limit."
          trailing={<span className="text-xs">km</span>}
          autoComplete="off"
        />
      )}
      {approving && <MoneyInput label="Amount recovered" value={amount} onChange={setAmount} required />}
      <div role="alert" className="empty:hidden">
        {error && <p className="text-sm font-medium text-danger">{error}</p>}
      </div>
      {next.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {next.map((status) => (
            <Button key={status} size="sm" variant={status === 'rejected' ? 'secondary' : 'primary'} onClick={() => void move(status)} loading={update.isPending && update.variables?.status === status}>
              {status === 'approved' && approving ? 'Save approval' : ACTIONS[status]}
            </Button>
          ))}
          {approving && (
            <Button size="sm" variant="ghost" onClick={() => setApproving(false)}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
