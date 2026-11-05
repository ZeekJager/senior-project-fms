import { AlertTriangle, RadioTower } from 'lucide-react'
import { Badge, Card, cn } from '@/components/ui'
import type { Provider } from './api'
import { STATUS, ago, blocker, plural, when } from './describe'

const CIRCUIT = { closed: 'Closed', open: 'Open: calls paused', half_open: 'Half open: trying again' } as const

/**
 * One telematics provider's status (FMS-138): whether it is receiving, when its last delivery was stored, today's
 * deliveries and positions (stored and refused), its devices, and its circuit on this API instance.
 */
export function ProviderPanel({ provider: p, now }: { provider: Provider; now: number }) {
  const status = STATUS[p.status]
  const problem = blocker(p)
  const refused = p.today.deliveries_rejected + p.today.positions_rejected
  return (
    <Card className={cn('flex flex-col gap-4 p-5', !p.is_active && 'bg-surface-muted/60')}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-ink [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden>
            <RadioTower />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{p.name}</h3>
            <p className="truncate font-mono text-xs text-ink-subtle">/webhooks/telematics/{p.code}</p>
          </div>
        </div>
        <Badge tone={status.tone} dot>
          {status.label}
        </Badge>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-xs text-ink-subtle">Last delivery</dt>
          <dd className="mt-0.5 font-medium text-ink" title={p.last_delivery_at ? when(p.last_delivery_at) : undefined}>
            {ago(p.last_delivery_at, now)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">Devices</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {plural(p.devices?.linked ?? 0, 'linked', 'linked')}
            {(p.devices?.unknown ?? 0) > 0 && <span className="font-normal text-warning"> · {p.devices!.unknown} unlinked</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">Today</dt>
          <dd className="mt-0.5 font-medium tabular-nums text-ink">
            {plural(p.today.deliveries, 'delivery', 'deliveries')}, {plural(p.today.positions_accepted, 'position')}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">Refused today</dt>
          <dd className={cn('mt-0.5 font-medium tabular-nums', refused > 0 ? 'text-danger' : 'text-ink')}>
            {refused === 0 ? 'None' : [p.today.deliveries_rejected > 0 && plural(p.today.deliveries_rejected, 'delivery', 'deliveries'), p.today.positions_rejected > 0 && plural(p.today.positions_rejected, 'position')].filter(Boolean).join(', ')}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-ink-subtle">Circuit</dt>
          <dd className="mt-0.5 text-ink-muted">{p.circuit ? CIRCUIT[p.circuit.state] : 'Not called: this provider only sends webhooks'}</dd>
        </div>
      </dl>

      {problem && (
        <p role="note" className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          {problem}
        </p>
      )}
    </Card>
  )
}
