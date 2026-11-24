import type { ReactNode } from 'react'

// What S-30 Backups words and draws the same way in each of its sections: Addis Ababa times, sizes, ages, and a fact card.

const TZ = 'Africa/Addis_Ababa'
const when = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const whenSeconds = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

/** 4 Nov 2026, 14:05 (Addis Ababa) */
export const at = (iso: string) => when.format(new Date(iso))
/** 4 Nov, 14:05:09: a point the database can be restored to, to the second. */
export const atSecond = (iso: string) => whenSeconds.format(new Date(iso))

/** 1.4 MB, 312 KB: a backup's size the way a person reads it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** "3 min ago", "2 h ago", "4 days ago": how fresh something is. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

/** 45 s, 1 min 20 s, 1 h 5 min: how long a restore took. */
export function seconds(total: number): string {
  if (total < 60) return `${total} s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s > 0 ? `${m} min ${s} s` : `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 > 0 ? `${h} h ${m % 60} min` : `${h} h`
}

export function Fact({ icon, label, children, tone = 'neutral' }: { icon: ReactNode; label: string; children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const iconTone = { neutral: 'text-ink-subtle', success: 'text-success', warning: 'text-warning', danger: 'text-danger' }[tone]
  return (
    <div className="min-w-0 rounded-card border border-line bg-surface p-4 shadow-soft">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-muted [&_svg]:h-4 [&_svg]:w-4">
        <span aria-hidden="true" className={iconTone}>
          {icon}
        </span>
        {label}
      </p>
      <div className="mt-2 text-sm text-ink">{children}</div>
    </div>
  )
}
