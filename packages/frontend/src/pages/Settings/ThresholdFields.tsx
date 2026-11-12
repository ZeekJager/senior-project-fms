import { SelectField, TextField } from '@/components/ui'
import {
  POLICY_KEYS,
  THRESHOLD_LIMITS,
  WEIGHT_KEYS,
  parseWeight,
  parseWhole,
  type ExceptionPolicy,
  type PolicyKey,
  type ThresholdKey,
  type Thresholds,
  type WeightKey,
} from './api'

/** The thresholds as typed, and the assignment exception policies as chosen. */
export type ThresholdValues = Record<ThresholdKey | PolicyKey | WeightKey, string>
export type ThresholdErrors = Partial<Record<ThresholdKey | PolicyKey | WeightKey, string>>
type FieldKey = ThresholdKey | WeightKey

/** The assignment warnings that can wait for a fleet manager (FMS-151). The safety rules always refuse. */
const POLICIES: { key: PolicyKey; label: string; hint: string }[] = [
  { key: 'driver_attendance_exception', label: 'Driver marked absent', hint: 'Absent, on leave or sick on the trip’s day.' },
  { key: 'trip_overrun_exception', label: 'Previous trip running over', hint: 'A trip still under way runs into this one.' },
]

const POLICY_OPTIONS: { value: ExceptionPolicy; label: string }[] = [
  { value: 'warn', label: 'Warn, then assign' },
  { value: 'approve', label: 'Needs a fleet manager’s approval' },
]

const FIELDS: { key: ThresholdKey; label: string; unit: string; hint: string }[] = [
  { key: 'speed_limit_kmh', label: 'Speed limit', unit: 'km/h', hint: 'Exactly the limit is not speeding.' },
  { key: 'speeding_pings', label: 'Speeding after', unit: 'pings', hint: 'In a row over the limit. A ping comes about every 10 s.' },
  { key: 'clear_pings', label: 'Cleared after', unit: 'pings', hint: 'In a row at or under the limit.' },
  { key: 'idle_minutes', label: 'Idling after', unit: 'min', hint: 'At 0 km/h with the engine not reported off.' },
  { key: 'route_deviation_m', label: 'Off route beyond', unit: 'm', hint: 'From the trip’s road. GPS drifts 10 to 50 m.' },
  { key: 'route_deviation_pings', label: 'Off route after', unit: 'pings', hint: 'In a row that far out. Cleared like speeding.' },
  { key: 'trip_delay_minutes', label: 'Trip late after', unit: 'min', hint: 'Expected past its scheduled end. Dispatchers are told.' },
  { key: 'trip_delay_urgent_minutes', label: 'Trip urgent after', unit: 'min', hint: 'Past its end. Told again by email, SMS and push.' },
]

/** FMS-156: how far a driver may be given to drive, load-weighted. A safety rule: it always refuses. */
const DISTANCE_FIELDS: { key: ThresholdKey; label: string; unit: string; hint: string }[] = [
  { key: 'daily_distance_km', label: 'Daily limit', unit: 'km', hint: 'A calendar day in Addis Ababa, by when trips start.' },
  { key: 'weekly_distance_km', label: 'Weekly limit', unit: 'km', hint: 'Monday to Sunday. At least the daily limit.' },
]

const WEIGHT_FIELDS: { key: WeightKey; label: string; hint: string }[] = [
  { key: 'distance_weight_light', label: 'Light job', hint: 'Short, few stops, little cargo.' },
  { key: 'distance_weight_standard', label: 'Standard job', hint: 'A km counts as a km at 1.' },
  { key: 'distance_weight_heavy', label: 'Heavy job', hint: 'Long haul, long hours, night, near payload.' },
]

const WHOLE_FIELDS = [...FIELDS, ...DISTANCE_FIELDS]

export const toValues = (t: Thresholds): ThresholdValues => ({
  speed_limit_kmh: String(t.speed_limit_kmh),
  speeding_pings: String(t.speeding_pings),
  clear_pings: String(t.clear_pings),
  idle_minutes: String(t.idle_minutes),
  route_deviation_m: String(t.route_deviation_m),
  route_deviation_pings: String(t.route_deviation_pings),
  trip_delay_minutes: String(t.trip_delay_minutes),
  trip_delay_urgent_minutes: String(t.trip_delay_urgent_minutes),
  driver_attendance_exception: t.driver_attendance_exception,
  trip_overrun_exception: t.trip_overrun_exception,
  daily_distance_km: String(t.daily_distance_km),
  weekly_distance_km: String(t.weekly_distance_km),
  distance_weight_light: String(t.distance_weight_light),
  distance_weight_standard: String(t.distance_weight_standard),
  distance_weight_heavy: String(t.distance_weight_heavy),
})

export function validateThresholds(v: ThresholdValues): { errors: ThresholdErrors; thresholds: Thresholds | null } {
  const errors: ThresholdErrors = {}
  const out: Partial<Thresholds> = {}
  for (const { key } of WHOLE_FIELDS) {
    const parsed = parseWhole(v[key], THRESHOLD_LIMITS[key].min, THRESHOLD_LIMITS[key].max)
    if (parsed.ok) out[key] = parsed.value
    else errors[key] = parsed.error
  }
  for (const key of WEIGHT_KEYS) {
    const parsed = parseWeight(v[key])
    if (parsed.ok) out[key] = parsed.value
    else errors[key] = parsed.error
  }
  // A week holds at least a day; a heavier job never counts for less (the API refuses them too).
  if (out.daily_distance_km !== undefined && out.weekly_distance_km !== undefined && out.weekly_distance_km < out.daily_distance_km) {
    errors.weekly_distance_km = `Enter at least the daily ${out.daily_distance_km} km.`
  }
  if (out.distance_weight_light !== undefined && out.distance_weight_standard !== undefined && out.distance_weight_light > out.distance_weight_standard) {
    errors.distance_weight_light = `No more than a standard job's ${out.distance_weight_standard}.`
  }
  if (out.distance_weight_standard !== undefined && out.distance_weight_heavy !== undefined && out.distance_weight_heavy < out.distance_weight_standard) {
    errors.distance_weight_heavy = `At least a standard job's ${out.distance_weight_standard}.`
  }
  // A trip is urgent later than it is late (the API refuses it too).
  if (out.trip_delay_minutes !== undefined && out.trip_delay_urgent_minutes !== undefined && out.trip_delay_urgent_minutes <= out.trip_delay_minutes) {
    errors.trip_delay_urgent_minutes = `Enter more than the ${out.trip_delay_minutes} min a trip is late after.`
  }
  for (const key of POLICY_KEYS) out[key] = v[key] === 'approve' ? 'approve' : 'warn'
  return { errors, thresholds: Object.keys(errors).length ? null : (out as Thresholds) }
}

export const sameThresholds = (v: ThresholdValues, t: Thresholds) =>
  WHOLE_FIELDS.every(({ key }) => v[key].trim() === String(t[key])) &&
  WEIGHT_KEYS.every((key) => Number(v[key].trim().replace(',', '.')) === t[key]) &&
  POLICY_KEYS.every((key) => v[key] === t[key])

/**
 * The speeding, idling, route deviation and trip delay thresholds, two to a row from small screens up; then whether
 * each assignment warning waits for a fleet manager (FMS-151); then the driving distance limits and the job loads' weights (FMS-156).
 */
export function ThresholdFields({ values, errors, onChange, idPrefix }: { values: ThresholdValues; errors: ThresholdErrors; onChange: (key: FieldKey | PolicyKey, value: string) => void; idPrefix?: string }) {
  const id = (key: string) => (idPrefix ? `${idPrefix}-${key}` : undefined)
  return (
    <div className="space-y-4">
      <div className="grid gap-x-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <TextField
            key={f.key}
            id={idPrefix ? `${idPrefix}-${f.key}` : undefined}
            label={f.label}
            inputMode="numeric"
            value={values[f.key]}
            onChange={(e) => onChange(f.key, e.target.value)}
            error={errors[f.key]}
            hint={f.hint}
            trailing={<span className="text-xs">{f.unit}</span>}
            autoComplete="off"
          />
        ))}
      </div>
      <div className="border-t border-line pt-4">
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-ink">Assigning through a warning</legend>
          <p className="text-xs text-ink-subtle">An overlap, a vehicle in the workshop or a licence that does not cover it always refuses. These two only warn, unless a fleet manager must approve.</p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {POLICIES.map((p) => (
              <SelectField
                key={p.key}
                id={idPrefix ? `${idPrefix}-${p.key}` : undefined}
                label={p.label}
                value={values[p.key]}
                onChange={(e) => onChange(p.key, e.target.value)}
                options={POLICY_OPTIONS}
                hint={p.hint}
              />
            ))}
          </div>
        </fieldset>
      </div>
      <div className="border-t border-line pt-4">
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-ink">Driving distance limits</legend>
          <p className="text-xs text-ink-subtle">
            A driver is never assigned a trip that takes them past a limit, counting each trip’s km times its job’s weight. At 80% the console warns. No approval overrides it.
          </p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {DISTANCE_FIELDS.map((f) => (
              <TextField
                key={f.key}
                id={id(f.key)}
                label={f.label}
                inputMode="numeric"
                value={values[f.key]}
                onChange={(e) => onChange(f.key, e.target.value)}
                error={errors[f.key]}
                hint={f.hint}
                trailing={<span className="text-xs">{f.unit}</span>}
                autoComplete="off"
              />
            ))}
          </div>
          <div className="grid gap-x-4 sm:grid-cols-3">
            {WEIGHT_FIELDS.map((f) => (
              <TextField
                key={f.key}
                id={id(f.key)}
                label={f.label}
                inputMode="decimal"
                value={values[f.key]}
                onChange={(e) => onChange(f.key, e.target.value)}
                error={errors[f.key]}
                hint={f.hint}
                trailing={<span className="text-xs">× km</span>}
                autoComplete="off"
              />
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  )
}
