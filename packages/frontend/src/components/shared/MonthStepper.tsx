import { ChevronLeft, ChevronRight } from 'lucide-react'
import { IconButton } from '@/components/ui'
import { currentMonth, monthLabel, shiftMonth, type Month } from '@/lib/month'

/** "‹ September 2026 ›": a calendar month in Addis Ababa, stepped one at a time; no month not yet begun. */
export function MonthStepper({ month, onChange }: { month: Month; onChange: (month: Month) => void }) {
  const latest = currentMonth()
  return (
    <div className="flex h-9 items-center rounded-control border border-line bg-surface coarse:h-11" role="group" aria-label="Month">
      <IconButton label="Previous month" size="sm" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => onChange(shiftMonth(month, -1))} />
      <span className="tabular min-w-[9.5rem] px-1 text-center text-sm font-medium text-ink" aria-live="polite">
        {monthLabel(month)}
      </span>
      <IconButton label="Next month" size="sm" icon={<ChevronRight className="h-4 w-4" />} disabled={month >= latest} onClick={() => onChange(shiftMonth(month, 1))} />
    </div>
  )
}
