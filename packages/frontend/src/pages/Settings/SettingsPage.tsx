import { ChevronRight, Download, Lock, Pencil, Plus, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState, ErrorState, ListToolbar } from '@/components/shared'
import { Badge, Button, Card, FilterSelect, Skeleton } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { downloadCsv, toCsv } from '@/lib/csv'
import { formatDateTime } from '@/pages/VehicleHistory/format'
import { DepotThresholdsDrawer } from './DepotThresholdsDrawer'
import { NewParameterDrawer } from './NewParameterDrawer'
import { ParameterDrawer } from './ParameterDrawer'
import { DEFAULT_THRESHOLDS, useRuleThresholds, type Thresholds, type ThresholdsRow } from './api'
import { formatValue, TYPE_LABELS, useParameters, type Parameter } from './registry'

type View = 'all' | 'changed' | 'disabled'

/** The system parameters' categories first, in the order the rules run; custom ones after, by name. */
const CATEGORY_ORDER = ['Driving rules', 'Trip delays', 'Assignment', 'Distance limits', 'Alerts and anomalies', 'Driver score']

/** An id from a category's name: names have spaces, ids cannot. */
const slug = (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, '-')

const categoryRank = (c: string) => {
  const i = CATEGORY_ORDER.indexOf(c)
  return i < 0 ? CATEGORY_ORDER.length : i
}

function matches(p: Parameter, view: View, query: string, category: string): boolean {
  if (view === 'changed' && p.is_default) return false
  if (view === 'disabled' && p.is_enabled) return false
  if (category && p.category !== category) return false
  const q = query.trim().toLowerCase()
  return !q || [p.label, p.key, p.description, p.category].some((s) => s.toLowerCase().includes(q))
}

/**
 * Settings (S-27, FMS-80, FMS-157): every parameter the rules and reports read, by category, each changed without a
 * code change or a deployment. settings:write changes values; settings:define adds parameters, enables, disables and
 * deletes them. Every change is audited and reaches every server within seconds.
 */
export function SettingsPage() {
  const { hasPermission } = useAuth()
  const canDefine = hasPermission('settings:define')
  const parameters = useParameters()
  const [view, setView] = useState<View>('all')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const all = parameters.data ?? []
  const categories = useMemo(() => [...new Set(all.map((p) => p.category))].sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b)), [all])
  const shown = all.filter((p) => matches(p, view, query, category))
  const groups = categories.map((c) => ({ category: c, items: shown.filter((p) => p.category === c) })).filter((g) => g.items.length > 0)
  const open = all.find((p) => p.key === openKey) ?? null
  const filtered = view !== 'all' || query.trim() !== '' || category !== ''

  function exportList() {
    const rows = shown.map((p) => [
      p.category,
      p.label,
      p.key,
      TYPE_LABELS[p.type],
      formatValue(p, p.value, p.has_value),
      p.is_secret ? 'Hidden' : formatValue(p, p.default_value),
      p.is_enabled ? 'Enabled' : 'Disabled',
      p.is_system ? 'System' : 'Custom',
      p.value_changed_at,
      p.value_changed_by_name,
    ])
    downloadCsv('settings.csv', toCsv(['Category', 'Name', 'Key', 'Type', 'Value', 'Default', 'Enabled', 'Kind', 'Changed at (UTC)', 'Changed by'], rows))
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Settings</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">What the rules, alerts and reports apply. A change reaches every server within seconds, and its history keeps who made it and why.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" leadingIcon={<Download className="h-4 w-4" />} onClick={exportList} disabled={shown.length === 0}>
            Export CSV
          </Button>
          {canDefine && (
            <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Add parameter
            </Button>
          )}
        </div>
      </header>

      <ListToolbar
        views={{
          label: 'Which parameters',
          value: view,
          onChange: setView,
          options: [
            { value: 'all', label: 'All', count: parameters.data ? all.length : undefined },
            { value: 'changed', label: 'Changed from default', count: parameters.data ? all.filter((p) => !p.is_default).length : undefined },
            { value: 'disabled', label: 'Disabled', count: parameters.data ? all.filter((p) => !p.is_enabled).length : undefined },
          ],
        }}
        search={{ label: 'Search settings', placeholder: 'Search by name, key or description', value: query, onChange: setQuery }}
        onClear={
          filtered
            ? () => {
                setView('all')
                setQuery('')
                setCategory('')
              }
            : undefined
        }
      >
        <FilterSelect label="Category" value={category} onChange={setCategory} emptyValue="" options={[{ value: '', label: 'Every category' }, ...categories.map((c) => ({ value: c, label: c }))]} />
      </ListToolbar>

      {parameters.isError ? (
        <ErrorState error={parameters.error} onRetry={() => void parameters.refetch()} />
      ) : !parameters.data ? (
        <div className="space-y-4" aria-busy="true">
          {[0, 1].map((i) => (
            <Card key={i} className="space-y-3 p-5">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </Card>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<SlidersHorizontal />}
            heading={filtered ? 'No parameter matches' : 'No parameters yet'}
            description={filtered ? 'Try another search, or clear the filters.' : 'Add one, and code reads it with no deployment.'}
          />
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.category}>
            <section aria-labelledby={`cat-${slug(g.category)}`} className="p-2 sm:p-3">
              <div className="flex items-baseline justify-between gap-3 px-3 pb-2 pt-2">
                <h2 id={`cat-${slug(g.category)}`} className="text-base font-semibold text-ink">
                  {g.category}
                </h2>
                <span className="tabular text-xs text-ink-subtle">{g.items.length}</span>
              </div>
              <ul className="divide-y divide-line">
                {g.items.map((p) => (
                  <ParameterRow key={p.key} parameter={p} onOpen={() => setOpenKey(p.key)} />
                ))}
              </ul>
              {g.category === 'Driving rules' && <DepotOverrides />}
            </section>
          </Card>
        ))
      )}

      <ParameterDrawer parameter={open} onClose={() => setOpenKey(null)} onReload={() => void parameters.refetch()} />
      <NewParameterDrawer
        open={adding}
        onClose={() => setAdding(false)}
        categories={categories}
        onCreated={(key) => {
          setAdding(false)
          setView('all')
          setOpenKey(key)
        }}
      />
    </div>
  )
}

function ParameterRow({ parameter: p, onOpen }: { parameter: Parameter; onOpen: () => void }) {
  const changed = p.value_changed_at && !p.is_default ? `Changed ${p.value_changed_by_name ? `by ${p.value_changed_by_name}, ` : ''}${formatDateTime(p.value_changed_at)}` : 'Default'
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${p.label}: ${formatValue(p, p.value, p.has_value)}`}
        className="group flex w-full items-center gap-4 rounded-control px-3 py-3 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={p.is_enabled ? 'text-sm font-medium text-ink' : 'text-sm font-medium text-ink-muted'}>{p.label}</span>
            {!p.is_system && <Badge tone="brand">Custom</Badge>}
            {!p.is_enabled && <Badge tone="warning">Disabled</Badge>}
            {p.is_secret && (
              <Badge tone="neutral" icon={<Lock className="h-3 w-3" />}>
                Secret
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-subtle">
            <span className="font-mono">{p.key}</span>
            {p.description && <> · {p.description}</>}
          </span>
        </span>
        <span className="hidden shrink-0 text-right sm:block">
          <span className={p.is_default ? 'tabular block text-sm text-ink-muted' : 'tabular block text-sm font-semibold text-ink'}>{formatValue(p, p.value, p.has_value)}</span>
          <span className="block text-xs text-ink-subtle">{p.is_enabled ? changed : 'Answers with its default'}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </button>
    </li>
  )
}

/** Depots with driving rules of their own (FMS-80): they keep theirs whatever the fleet's parameters say. */
function DepotOverrides() {
  const rules = useRuleThresholds()
  const depots = useDepots()
  const [drawer, setDrawer] = useState<{ depotId: string | null } | null>(null)
  const names = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d.name])), [depots.data])
  const depotName = (id: string) => names.get(id) ?? 'This depot'
  const own = rules.data?.depots ?? []
  const fleet = rules.data?.fleet
  const choices = (depots.data ?? []).filter((d) => !own.some((o) => o.depot_id === d.id))
  const drawerStart: Thresholds = useMemo(() => {
    const row = drawer?.depotId ? own.find((o) => o.depot_id === drawer.depotId) : undefined
    return row ?? fleet ?? DEFAULT_THRESHOLDS
  }, [drawer, own, fleet])

  return (
    <div className="mx-3 mb-2 mt-3 space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Depots with their own</h3>
          <p className="text-xs text-ink-subtle">A depot’s own driving rules replace the fleet’s above for its vehicles.</p>
        </div>
        <Button variant="secondary" size="sm" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setDrawer({ depotId: null })} disabled={!rules.data || choices.length === 0}>
          Thresholds for a depot
        </Button>
      </div>
      {rules.isError ? (
        <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
      ) : !rules.data ? (
        <Skeleton className="h-12" />
      ) : own.length === 0 ? (
        <p className="text-sm text-ink-subtle">None: every depot follows the fleet’s.</p>
      ) : (
        <ul className="divide-y divide-line rounded-control border border-line">
          {own.map((row) => (
            <DepotRow key={row.depot_id} name={depotName(row.depot_id)} row={row} onEdit={() => setDrawer({ depotId: row.depot_id })} />
          ))}
        </ul>
      )}
      <DepotThresholdsDrawer open={drawer !== null} onClose={() => setDrawer(null)} depotId={drawer?.depotId ?? null} start={drawerStart} choices={choices} depotName={depotName} />
    </div>
  )
}

/** Which assignment warnings the row holds for a fleet manager (FMS-151), or null when both only warn. */
function approvals(row: ThresholdsRow): string | null {
  const held = [row.driver_attendance_exception === 'approve' ? 'absent driver' : null, row.trip_overrun_exception === 'approve' ? 'previous trip running over' : null].filter(Boolean)
  return held.length ? `approval for ${held.join(' and ')}` : null
}

function DepotRow({ name, row, onEdit }: { name: string; row: ThresholdsRow; onEdit: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{name}</p>
        <p className="text-xs text-ink-subtle">
          <span className="tabular">{row.speed_limit_kmh} km/h</span> after <span className="tabular">{row.speeding_pings}</span>, cleared after{' '}
          <span className="tabular">{row.clear_pings}</span> · idling after <span className="tabular">{row.idle_minutes} min</span> · off route beyond{' '}
          <span className="tabular">{row.route_deviation_m.toLocaleString('en-US')} m</span> for <span className="tabular">{row.route_deviation_pings}</span> · trips late
          after <span className="tabular">{row.trip_delay_minutes} min</span>, urgent after <span className="tabular">{row.trip_delay_urgent_minutes} min</span>
          {' '}· driving at most <span className="tabular">{row.daily_distance_km.toLocaleString('en-US')} km</span> a day,{' '}
          <span className="tabular">{row.weekly_distance_km.toLocaleString('en-US')} km</span> a week
          {approvals(row) && <> · {approvals(row)}</>}
        </p>
      </div>
      <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={onEdit} aria-label={`Edit ${name}'s thresholds`}>
        Edit
      </Button>
    </li>
  )
}
