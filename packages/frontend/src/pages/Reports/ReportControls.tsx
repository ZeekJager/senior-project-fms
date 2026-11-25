import { Bookmark, Building2, CalendarRange, Check, ChevronDown, SlidersHorizontal, Trash2, Truck, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { MonthStepper } from '@/components/shared'
import { Button, cn, Combobox, Drawer, FilterSelect, IconButton, SelectField, TextField, useToast, type ComboboxOption } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { VEHICLE_TYPES } from '@/features/service-due/api'
import { VEHICLE_TYPE_LABELS } from '@/features/service-due/format'
import { currentMonth, shiftMonth } from '@/lib/month'
import { ApiError } from '@/lib/api/errors'
import {
  filterCount,
  fromSaved,
  quarterOf,
  SAFETY_GROUPS,
  savedBody,
  useDeleteFilter,
  usePickOptions,
  useSavedFilters,
  useSaveFilter,
  type PeriodKind,
  type PickOption,
  type Report,
  type SafetyGroup,
  type ScreenState,
} from './api'

// The period and filter controls of S-28 Reports and the KPI dashboard (FMS-160): a month, a quarter, a year or a
// range of up to 366 days; several depots; a vehicle type; a vehicle, a driver and a route; saved combinations.

const MAX_RANGE_DAYS = 366
const DAY_MS = 86_400_000

const PERIOD_OPTIONS: readonly { value: PeriodKind; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
  { value: 'range', label: 'Custom range' },
]

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date())

/** The last eight quarters, newest first. */
function quarters(): { value: string; label: string }[] {
  let month = currentMonth()
  const out: { value: string; label: string }[] = []
  for (let i = 0; i < 8; i++) {
    const q = quarterOf(month)
    out.push({ value: q, label: `Q${q.slice(-1)} ${q.slice(0, 4)}` })
    month = shiftMonth(`${q.slice(0, 4)}-${String((Number(q.slice(-1)) - 1) * 3 + 1).padStart(2, '0')}`, -1)
  }
  return out
}

const years = () => Array.from({ length: 5 }, (_, i) => String(Number(currentMonth().slice(0, 4)) - i)).map((y) => ({ value: y, label: y }))

/** Why a custom range is refused, before it is sent; null when it is fine. */
export function rangeProblem(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both days.'
  if (to < from) return 'The last day is before the first.'
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1
  if (days > MAX_RANGE_DAYS) return `A range is at most ${MAX_RANGE_DAYS} days.`
  if (from > today()) return 'That range has not begun.'
  return null
}

/** Month, quarter, year or custom range, and the control for the one chosen. */
export function PeriodPicker({ state, onChange }: { state: ScreenState; onChange: (patch: Partial<ScreenState>) => void }) {
  const [from, setFrom] = useState(state.from)
  const [to, setTo] = useState(state.to)
  useEffect(() => {
    setFrom(state.from)
    setTo(state.to)
  }, [state.from, state.to])
  const problem = state.period === 'range' ? rangeProblem(from, to) : null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect label="Period" icon={<CalendarRange />} value={state.period} options={PERIOD_OPTIONS} onChange={(period) => onChange({ period })} />
      {state.period === 'month' && <MonthStepper month={state.month} onChange={(month) => onChange({ month })} />}
      {state.period === 'quarter' && <FilterSelect label="Quarter" value={state.quarter} options={quarters()} onChange={(quarter) => onChange({ quarter })} />}
      {state.period === 'year' && <FilterSelect label="Year" value={state.year} options={years()} onChange={(year) => onChange({ year })} />}
      {state.period === 'range' && (
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!problem) onChange({ from, to })
          }}
        >
          <TextField label="First day" type="date" alwaysFloat value={from} max={today()} onChange={(e) => setFrom(e.target.value)} className="w-[10.5rem]" />
          <TextField label="Last day" type="date" alwaysFloat value={to} onChange={(e) => setTo(e.target.value)} error={problem ?? undefined} className="w-[10.5rem]" />
          <Button type="submit" variant="secondary" disabled={problem !== null || (from === state.from && to === state.to)} className="mt-1">
            Apply
          </Button>
        </form>
      )}
    </div>
  )
}

/** A button that opens a small panel below it; closes on Escape or a click elsewhere. */
function Popover({ label, icon, summary, active, children }: { label: string; icon: ReactNode; summary: string; active: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-9 items-center gap-2 rounded-control border px-3 text-sm font-medium transition-colors coarse:h-11 [&>svg]:h-4 [&>svg]:w-4',
          active ? 'border-brand/40 bg-brand-soft text-brand' : 'border-line bg-surface text-ink hover:bg-surface-muted',
        )}
      >
        {icon}
        <span className="sr-only">{label}: </span>
        <span>{summary}</span>
        <ChevronDown className="text-ink-subtle" />
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={label} className="absolute left-0 z-30 mt-2 w-72 rounded-card border border-line bg-surface p-2 shadow-elevated">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** Several depots at once; none chosen is every depot in the caller's scope. */
export function DepotsFilter({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const depots = useDepots()
  const list = depots.data ?? []
  if (list.length < 2) return null
  const summary = value.length === 0 ? 'All depots' : value.length === 1 ? (list.find((d) => d.id === value[0])?.name ?? '1 depot') : `${value.length} depots`
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  return (
    <Popover label="Depots" icon={<Building2 />} summary={summary} active={value.length > 0}>
      {() => (
        <div>
          <ul className="max-h-64 overflow-y-auto" aria-label="Depots">
            {list.map((d) => {
              const on = value.includes(d.id)
              return (
                <li key={d.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-control px-2 py-2 text-sm text-ink hover:bg-surface-muted">
                    <input type="checkbox" className="h-4 w-4 rounded border-line-strong accent-brand" checked={on} onChange={() => toggle(d.id)} />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    {on && <Check className="h-4 w-4 text-brand" aria-hidden="true" />}
                  </label>
                </li>
              )
            })}
          </ul>
          {value.length > 0 && (
            <div className="mt-1 border-t border-line pt-2">
              <Button variant="ghost" size="sm" onClick={() => onChange([])}>
                All depots
              </Button>
            </div>
          )}
        </div>
      )}
    </Popover>
  )
}

const TYPE_OPTIONS = [{ value: '', label: 'All types' }, ...VEHICLE_TYPES.map((t) => ({ value: t, label: VEHICLE_TYPE_LABELS[t] }))]

export function VehicleTypeFilter({ value, onChange }: { value: string; onChange: (type: string) => void }) {
  return <FilterSelect label="Vehicle type" icon={<Truck />} value={value} emptyValue="" options={TYPE_OPTIONS} onChange={onChange} />
}

/** A searchable vehicle, driver or route, labelled from the report's filter names once chosen. */
function PickField({ kind, label, value, name, onChange }: { kind: 'vehicles' | 'drivers' | 'routes'; label: string; value: string; name: string | null; onChange: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const options = usePickOptions(kind, query, true)
  const chosen: ComboboxOption<string> | null = value ? { value, key: value, label: name ?? 'Chosen' } : null
  return (
    <Combobox<string>
      label={label}
      value={chosen}
      onChange={(o) => onChange(o?.value ?? '')}
      query={query}
      onQueryChange={setQuery}
      loading={options.isFetching}
      options={(options.data ?? []).map((o: PickOption) => ({ value: o.id, key: o.id, label: o.label, detail: o.detail }))}
      emptyText="Nothing matches"
    />
  )
}

/** The vehicle, driver and route filters, and safety's grouping, in a drawer: they need room to search. */
export function MoreFilters({ state, names, onChange }: { state: ScreenState; names: Report['filter_names'] | undefined; onChange: (patch: Partial<ScreenState>) => void }) {
  const { hasPermission } = useAuth()
  const [open, setOpen] = useState(false)
  const set = [state.vehicleId, state.driverId, state.routeId].filter(Boolean).length
  return (
    <>
      <Button variant="secondary" leadingIcon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => setOpen(true)} aria-haspopup="dialog">
        More filters{set ? ` (${set})` : ''}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="More filters"
        description="Narrow the report to one vehicle, driver or route."
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        <div className="space-y-5">
          {hasPermission('vehicle:read') && <PickField kind="vehicles" label="Vehicle" value={state.vehicleId} name={names?.vehicle ?? null} onChange={(vehicleId) => onChange({ vehicleId })} />}
          {hasPermission('driver:read') && <PickField kind="drivers" label="Driver" value={state.driverId} name={names?.driver ?? null} onChange={(driverId) => onChange({ driverId })} />}
          {hasPermission('route:read') && <PickField kind="routes" label="Route" value={state.routeId} name={names?.route ?? null} onChange={(routeId) => onChange({ routeId })} />}
          {state.report === 'safety' && (
            <SelectField label="Safety rows" value={state.by} options={SAFETY_GROUPS} onChange={(e) => onChange({ by: e.target.value as SafetyGroup })} />
          )}
        </div>
      </Drawer>
    </>
  )
}

/** The filters in force past the period, each removable. */
export function FilterChips({ state, names, onChange }: { state: ScreenState; names: Report['filter_names'] | undefined; onChange: (patch: Partial<ScreenState>) => void }) {
  const chips: { key: string; text: string; clear: Partial<ScreenState> }[] = []
  if (state.depotIds.length) chips.push({ key: 'depots', text: names?.depots.length ? names.depots.join(', ') : `${state.depotIds.length} depots`, clear: { depotIds: [] } })
  if (state.vehicleType) chips.push({ key: 'type', text: VEHICLE_TYPE_LABELS[state.vehicleType as keyof typeof VEHICLE_TYPE_LABELS] ?? state.vehicleType, clear: { vehicleType: '' } })
  if (state.vehicleId) chips.push({ key: 'vehicle', text: names?.vehicle ?? 'A vehicle', clear: { vehicleId: '' } })
  if (state.driverId) chips.push({ key: 'driver', text: names?.driver ?? 'A driver', clear: { driverId: '' } })
  if (state.routeId) chips.push({ key: 'route', text: names?.route ?? 'A route', clear: { routeId: '' } })
  if (chips.length === 0) return null
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label="Filters in force">
      {chips.map((c) => (
        <li key={c.key} className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-surface-muted pl-3 pr-1 text-xs font-medium text-ink">
          <span className="max-w-[16rem] truncate">{c.text}</span>
          <IconButton label={`Remove ${c.text}`} size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={() => onChange(c.clear)} className="h-6 w-6" />
        </li>
      ))}
      {chips.length > 1 && (
        <li>
          <Button variant="ghost" size="sm" onClick={() => onChange({ depotIds: [], vehicleType: '', vehicleId: '', driverId: '', routeId: '' })}>
            Clear all
          </Button>
        </li>
      )}
    </ul>
  )
}

/** The caller's saved filter combinations: apply one, delete one, or save what is on screen by name. */
export function SavedFilters({ state, onApply }: { state: ScreenState; onApply: (next: ScreenState) => void }) {
  const { toast } = useToast()
  const saved = useSavedFilters()
  const save = useSaveFilter()
  const remove = useDeleteFilter()
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const list = saved.data ?? []
  return (
    <Popover label="Saved filters" icon={<Bookmark />} summary={list.length ? `Saved filters (${list.length})` : 'Saved filters'} active={false}>
      {(close) => (
        <div className="space-y-2">
          {list.length > 0 ? (
            <ul className="max-h-56 overflow-y-auto" aria-label="Saved filters">
              {list.map((f) => (
                <li key={f.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate rounded-control px-2 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                    onClick={() => {
                      onApply(fromSaved(state, f.filters))
                      close()
                    }}
                  >
                    {f.name}
                  </button>
                  <IconButton label={`Delete ${f.name}`} size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => remove.mutate(f.id)} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 py-1 text-sm text-ink-muted">Save the period and filters you use often, and bring them back in one click.</p>
          )}
          <form
            className="flex items-start gap-2 border-t border-line pt-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!name.trim()) return
              try {
                await save.mutateAsync({ name: name.trim(), filters: savedBody(state) })
                toast({ title: 'Filters saved', description: `“${name.trim()}” is in your saved filters.` })
                setName('')
                setProblem(null)
              } catch (err) {
                setProblem(err instanceof ApiError && err.status === 409 ? 'You already have filters by that name.' : 'They could not be saved. Try again.')
              }
            }}
          >
            <TextField label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} error={problem ?? undefined} className="min-w-0 flex-1" />
            <Button type="submit" variant="secondary" loading={save.isPending} disabled={!name.trim()} className="mt-1">
              Save
            </Button>
          </form>
          {filterCount(state) === 0 && state.period === 'month' && <p className="px-1 text-xs text-ink-subtle">Saves the period too.</p>}
        </div>
      )}
    </Popover>
  )
}
