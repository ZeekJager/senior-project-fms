import { formatMinor } from './decimal'

export const FUEL_DECIMALS = 3

export interface FuelDisplayProps {
  /** Integer millilitres (api-contract §3.5). */
  amountMinorUnits: number | null | undefined
  /** Litres is the assumed default until the unit setting exists (SE-75). */
  unit?: 'L'
  /** Decimals shown. Two by default (23500 ml is "23.50 L"); 3 shows every millilitre. */
  decimals?: 2 | 3
  className?: string
}

/** A fuel volume, right-aligned. See MoneyDisplay for the integer-only and invalid-value rules. */
export function FuelDisplay({ amountMinorUnits, unit = 'L', decimals = 2, className = '' }: FuelDisplayProps) {
  const valid = Number.isSafeInteger(amountMinorUnits)
  return (
    <span className={`block text-right tabular-nums ${className}`.trim()}>
      {valid ? `${formatMinor(amountMinorUnits as number, FUEL_DECIMALS, decimals)} ${unit}` : '—'}
    </span>
  )
}
