import { CalendarClock } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui'
import type { ServiceDueStatus } from './api'
import { STATUS_LABELS, STATUS_TONES } from './format'

/** A service's status, worded and coloured the same everywhere (FMS-129): never colour alone. */
export function ServiceDueBadge({ status, children, className }: { status: ServiceDueStatus; children?: ReactNode; className?: string }) {
  return (
    <Badge tone={STATUS_TONES[status]} icon={<CalendarClock aria-hidden="true" />} className={className}>
      {children ?? STATUS_LABELS[status]}
    </Badge>
  )
}
