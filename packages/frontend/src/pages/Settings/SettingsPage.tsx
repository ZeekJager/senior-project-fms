import { AlertCircle, Gauge, Pencil, Plus, Siren, Trophy } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ErrorState } from '@/components/shared'
import { Button, Card, Skeleton, TextField, useToast } from '@/components/ui'
import { useDepots } from '@/features/depots'
import { useSettings, type Setting, type SettingKey } from '@/features/settings'
import { ApiError } from '@/lib/api/errors'
import { formatDateTime } from '@/pages/VehicleHistory/format'
import { DepotThresholdsDrawer } from './DepotThresholdsDrawer'
import { ThresholdFields, sameThresholds, toValues, validateThresholds, type ThresholdErrors, type ThresholdValues } from './ThresholdFields'
import { DEFAULT_THRESHOLDS, parseWhole, useRuleThresholds, useSaveSettings, useSaveThresholds, type Thresholds, type ThresholdsRow } from './api'

const SETTING_COPY: Record<SettingKey, { label: string; unit: string; hint: (s: Setting) => string }> = {
  fuel_variance_threshold_pct: {
    label: 'Fuel variance',
    unit: '%',
    hint: (s) => `A vehicle's month of fuel this far above or below what its trips needed is an anomaly. ${s.min} to ${s.max}; default ${s.default_value}.`,
  },
  health_alert_below: {
    label: 'Health score alert line',
    unit: 'score',
    hint: (s) => `Below this a technician is alerted and the vehicle shows At risk. ${s.min} to ${s.max}; default ${s.default_value}.`,
  },
  expiry_warning_days: {
    label: 'Expiry warning',
    unit: 'days ahead',
    hint: (s) => `The first warning for a document or driving licence; the red one stays at 7 days. ${s.min} to ${s.max}; default ${s.default_value}.`,
  },
  driver_score_weight_punctuality: {
    label: 'Punctuality',
    unit: 'weight',
    hint: (s) => `Trips ended within 15 minutes of their scheduled end. ${s.min} to ${s.max}; default ${s.default_value}.`,
  },
  driver_score_weight_safety: {
    label: 'Safety',
    unit: 'weight',
    hint: (s) => `Speeding and idling per 100 km: 100 with none, 0 at 5 per 100 km. ${s.min} to ${s.max}; default ${s.default_value}.`,
  },
  driver_score_weight_incidents: {
    label: 'Incidents',
    unit: 'weight',
    hint: (s) => `Accidents per 100 km: 100 with none, 0 at one every 200 km. ${s.min} to ${s.max}; default ${s.default_value}.`,
  },
  driver_score_weight_dvir: {
    label: 'Inspections',
    unit: 'weight',
    hint: (s) => `Completed trips with the driver's pre-trip inspection. ${s.min} to ${s.max}; default ${s.default_value}.`,
  },
}

/** The settings each card edits. */
const ALERT_KEYS: readonly SettingKey[] = ['fuel_variance_threshold_pct', 'health_alert_below', 'expiry_warning_days']
const SCORE_KEYS: readonly SettingKey[] = ['driver_score_weight_punctuality', 'driver_score_weight_safety', 'driver_score_weight_incidents', 'driver_score_weight_dvir']

/** "Changed by Abebe Kebede, 2 Oct 2026, 09:40", or that it is the default. */
function changedLine(row: { updated_by_name: string | null; updated_at: string | null } | undefined, fallback: string): string {
  if (!row?.updated_at) return fallback
  return `Changed ${row.updated_by_name ? `by ${row.updated_by_name}, ` : ''}${formatDateTime(row.updated_at)}`
}

/**
 * Settings (S-27, FMS-80): the thresholds the rules apply, tuned without a code change. Admin only
 * (settings:write). Every change is audited and takes effect within a minute.
 */
export function SettingsPage() {
  return (
    <div className="space-y-6">
      <header className="border-b border-line pb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Settings</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">The thresholds the rules apply. A change takes effect within a minute, and the audit log records who made it.</p>
      </header>
      <DrivingRules />
      <SettingGroup
        id="alert-settings"
        icon={<Siren />}
        title="Alerts and anomalies"
        description="When fuel, vehicle health and expiring papers raise an alert."
        formLabel="Alert settings"
        keys={ALERT_KEYS}
      />
      <SettingGroup
        id="driver-score-settings"
        icon={<Trophy />}
        title="Driver score"
        description="How much each part counts in a driver's monthly score, 0 to 100. The score divides by their sum, so they need not add up to 100; 0 leaves a part out."
        formLabel="Driver score weights"
        keys={SCORE_KEYS}
        check={(next) => (SCORE_KEYS.every((k) => next[k] === 0) ? 'At least one weight must be above 0, or no driver could be scored.' : null)}
      />
    </div>
  )
}

function SettingsCard({ icon, title, description, children, id }: { icon: ReactNode; title: string; description: string; children: ReactNode; id: string }) {
  return (
    <Card>
      <section aria-labelledby={id} className="space-y-6 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden="true">
            {icon}
          </span>
          <div>
            <h2 id={id} className="text-base font-semibold text-ink">
              {title}
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
          </div>
        </div>
        {children}
      </section>
    </Card>
  )
}

function FormError({ message }: { message: string | null }) {
  return (
    <div role="alert" className="empty:hidden">
      {message && (
        <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {message}
        </div>
      )}
    </div>
  )
}

const serverMessage = (err: unknown) => (err instanceof ApiError ? `Not saved: ${err.message}` : 'Could not reach the server. Check your connection and try again.')

/** Speeding and idling (FMS-46) and route deviation (FMS-90): the fleet's thresholds, and depots that have their own. */
function DrivingRules() {
  const rules = useRuleThresholds()
  const depots = useDepots()
  const save = useSaveThresholds()
  const { toast } = useToast()
  const [values, setValues] = useState<ThresholdValues | null>(null)
  const [errors, setErrors] = useState<ThresholdErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ depotId: string | null } | null>(null)

  const fleet = rules.data?.fleet
  // The form starts from the server's values, and again after each save.
  useEffect(() => {
    if (fleet) setValues(toValues(fleet))
  }, [fleet])

  const names = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d.name])), [depots.data])
  const depotName = (id: string) => names.get(id) ?? 'This depot'
  const own = rules.data?.depots ?? []
  const choices = (depots.data ?? []).filter((d) => !own.some((o) => o.depot_id === d.id))
  const dirty = Boolean(values && fleet && !sameThresholds(values, fleet))

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!values || save.isPending) return
    setFormError(null)
    const { errors: found, thresholds } = validateThresholds(values)
    setErrors(found)
    if (!thresholds) return
    try {
      await save.mutateAsync({ depotId: null, thresholds })
      toast({ title: 'Driving rules saved', description: 'Every vehicle without its depot’s own thresholds follows them within a minute.' })
    } catch (err) {
      setFormError(serverMessage(err))
    }
  }

  const drawerStart: Thresholds = useMemo(() => {
    const row = drawer?.depotId ? own.find((o) => o.depot_id === drawer.depotId) : undefined
    return row ?? fleet ?? DEFAULT_THRESHOLDS
  }, [drawer, own, fleet])

  return (
    <SettingsCard id="driving-rules" icon={<Gauge />} title="Driving rules" description="Speeding, idling and off-route flags from each vehicle's GPS pings, and when a trip is running late. A depot can have its own.">
      {rules.isError ? (
        <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
      ) : !values || !fleet ? (
        <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : (
        <>
          <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label="The fleet's driving rules">
            <FormError message={formError} />
            <ThresholdFields
              idPrefix="fleet"
              values={values}
              errors={errors}
              onChange={(key, value) => {
                setValues((v) => (v ? { ...v, [key]: value } : v))
                if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }))
              }}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-ink-subtle">{changedLine(fleet, 'The fleet’s starting thresholds.')}</p>
              <Button type="submit" loading={save.isPending} disabled={!dirty}>
                Save driving rules
              </Button>
            </div>
          </form>

          <div className="space-y-3 border-t border-line pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">Depots with their own</h3>
              <Button variant="secondary" size="sm" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setDrawer({ depotId: null })} disabled={choices.length === 0}>
                Thresholds for a depot
              </Button>
            </div>
            {own.length === 0 ? (
              <p className="text-sm text-ink-subtle">None: every depot follows the fleet’s.</p>
            ) : (
              <ul className="divide-y divide-line rounded-control border border-line">
                {own.map((row) => (
                  <DepotRow key={row.depot_id} name={depotName(row.depot_id)} row={row} onEdit={() => setDrawer({ depotId: row.depot_id })} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      <DepotThresholdsDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        depotId={drawer?.depotId ?? null}
        start={drawerStart}
        choices={choices}
        depotName={depotName}
      />
    </SettingsCard>
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

/**
 * A card of settings (GET and PATCH /settings): the alert lines (fuel variance, the health score's alert line, the
 * expiry warning), or the driver score's weights (FMS-146). `check` refuses a combination before it is sent.
 */
function SettingGroup({
  id,
  icon,
  title,
  description,
  formLabel,
  keys,
  check,
}: {
  id: string
  icon: ReactNode
  title: string
  description: string
  formLabel: string
  keys: readonly SettingKey[]
  check?: (next: Record<SettingKey, number>) => string | null
}) {
  const settings = useSettings()
  const save = useSaveSettings()
  const { toast } = useToast()
  const [values, setValues] = useState<Partial<Record<SettingKey, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (settings.data) setValues(Object.fromEntries(settings.data.map((s) => [s.key, String(s.value)])))
  }, [settings.data])

  const list = (settings.data ?? []).filter((s) => keys.includes(s.key))
  const changed = list.filter((s) => values[s.key] !== undefined && values[s.key]!.trim() !== String(s.value))

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (save.isPending) return
    setFormError(null)
    const found: Partial<Record<SettingKey, string>> = {}
    const patch: Partial<Record<SettingKey, number>> = {}
    for (const s of changed) {
      const parsed = parseWhole(values[s.key] ?? '', s.min, s.max)
      if (parsed.ok) patch[s.key] = parsed.value
      else found[s.key] = parsed.error
    }
    setErrors(found)
    if (Object.keys(found).length || !Object.keys(patch).length) return
    const refused = check?.({ ...(Object.fromEntries(list.map((s) => [s.key, s.value])) as Record<SettingKey, number>), ...patch })
    if (refused) {
      setFormError(refused)
      return
    }
    try {
      await save.mutateAsync(patch)
      toast({ title: 'Settings saved', description: 'The rules use them within a minute.' })
    } catch (err) {
      setFormError(serverMessage(err))
    }
  }

  return (
    <SettingsCard id={id} icon={icon} title={title} description={description}>
      {settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : settings.isPending ? (
        <div className="space-y-4" aria-busy="true">
          {keys.map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label={formLabel}>
          <FormError message={formError} />
          <div className="divide-y divide-line">
            {list.map((s) => {
              const copy = SETTING_COPY[s.key]
              const typed = values[s.key] ?? ''
              return (
                <div key={s.key} className="grid gap-x-6 gap-y-2 py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_220px]">
                  <div className="min-w-0">
                    <p className="text-sm text-ink-muted">{copy.hint(s)}</p>
                    <p className="mt-1 text-xs text-ink-subtle">{changedLine(s, 'At its default.')}</p>
                  </div>
                  <div>
                    <TextField
                      label={copy.label}
                      inputMode="numeric"
                      value={typed}
                      onChange={(e) => {
                        setValues((v) => ({ ...v, [s.key]: e.target.value }))
                        if (errors[s.key]) setErrors((x) => ({ ...x, [s.key]: undefined }))
                      }}
                      error={errors[s.key]}
                      trailing={<span className="text-xs">{copy.unit}</span>}
                      autoComplete="off"
                    />
                    {typed.trim() !== String(s.default_value) && (
                      <button type="button" className="focus-ring rounded text-xs font-medium text-brand hover:underline" onClick={() => setValues((v) => ({ ...v, [s.key]: String(s.default_value) }))}>
                        Use the default ({s.default_value})
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending} disabled={changed.length === 0}>
              Save settings
            </Button>
          </div>
        </form>
      )}
    </SettingsCard>
  )
}
