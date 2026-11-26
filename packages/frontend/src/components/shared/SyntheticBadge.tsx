import { FlaskConical } from 'lucide-react'
import { Badge } from '../ui'

/** Where an EV record came from (FMS-97, docs/ev.md): typed in, a charging provider's webhook, or fabricated. */
export type RecordSource = 'manual' | 'provider' | 'synthetic'

/** Whether any of these records is synthetic: a screen showing them all badges itself once. */
export const anySynthetic = (records: readonly { source?: RecordSource | null }[]): boolean => records.some((r) => r.source === 'synthetic')

/**
 * The "Synthetic data" badge (FMS-97, decision D-06): there is no real EV data source, so the EV screens (FMS-99) say
 * so on every fabricated record, or once on a screen of them. Nothing for real data.
 */
export function SyntheticBadge({ source, className }: { source: RecordSource | null | undefined; className?: string }) {
  if (source !== 'synthetic') return null
  return (
    <span title="Generated for development and the demonstration: not measured on a real vehicle or charger." className={className}>
      <Badge tone="info" icon={<FlaskConical aria-hidden="true" />}>
        Synthetic data
      </Badge>
    </span>
  )
}
