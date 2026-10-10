import { AlertOctagon, BadgeCheck, CalendarClock, Users } from 'lucide-react'
import { StatCard, StatShare } from '@/components/shared'
import type { DriverFilters } from './filters'
import type { LicenseStatus } from './types'

interface Counts {
  total?: number
  valid?: number
  expiring?: number
  expired?: number
}

const percent = (part: number | undefined, whole: number | undefined) =>
  part === undefined || !whole ? 0 : Math.round((part * 100) / whole)

/** Licence health at a glance; each card filters the table to its drivers. */
export function LicenceStats({
  counts,
  isLoading,
  filters,
  onSelect,
}: {
  counts: Counts
  isLoading: boolean
  filters: DriverFilters
  onSelect: (licence: LicenseStatus | '') => void
}) {
  const current = filters.retired ? null : filters.licence
  return (
    <section aria-label="Licence summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        label="Active drivers"
        value={counts.total}
        isLoading={isLoading}
        icon={<Users />}
        tone="brand"
        pressed={current === ''}
        onClick={() => onSelect('')}
        footer={<StatShare value={percent(counts.valid, counts.total)} tone="brand" caption="hold a valid licence" />}
      />
      <StatCard
        label="Valid licences"
        value={counts.valid}
        isLoading={isLoading}
        icon={<BadgeCheck />}
        tone="success"
        pressed={current === 'valid'}
        onClick={() => onSelect('valid')}
        footer={<StatShare value={percent(counts.valid, counts.total)} tone="success" caption="valid beyond 30 days" />}
      />
      <StatCard
        label="Expiring soon"
        value={counts.expiring}
        isLoading={isLoading}
        icon={<CalendarClock />}
        tone="warning"
        pressed={current === 'expiring_soon'}
        onClick={() => onSelect('expiring_soon')}
        footer={<StatShare value={percent(counts.expiring, counts.total)} tone="warning" caption="expire within 30 days" />}
      />
      <StatCard
        label="Expired"
        value={counts.expired}
        isLoading={isLoading}
        icon={<AlertOctagon />}
        tone="danger"
        pressed={current === 'expired'}
        onClick={() => onSelect('expired')}
        footer={<StatShare value={percent(counts.expired, counts.total)} tone="danger" caption="cannot be dispatched" />}
      />
    </section>
  )
}
