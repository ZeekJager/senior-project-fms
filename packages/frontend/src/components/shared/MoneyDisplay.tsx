import { formatMinor } from './decimal'

export const MONEY_DECIMALS = 2

export interface MoneyDisplayProps {
  /** Integer Ethiopian cents (api-contract §3.5). */
  amountMinorUnits: number | null | undefined
  /** Currency shown before the amount. */
  unit?: 'ETB'
  className?: string
}

/**
 * An amount of money, right-aligned with tabular digits so columns line up.
 * Takes integer cents and formats them with integer arithmetic only. A value
 * that is not a safe integer (a float that slipped through) renders as a dash
 * instead of a plausible but wrong number.
 */
export function MoneyDisplay({ amountMinorUnits, unit = 'ETB', className = '' }: MoneyDisplayProps) {
  const valid = Number.isSafeInteger(amountMinorUnits)
  return (
    <span className={`block text-right tabular-nums ${className}`.trim()}>
      {valid ? `${unit} ${formatMinor(amountMinorUnits as number, MONEY_DECIMALS)}` : '—'}
    </span>
  )
}
