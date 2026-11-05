import { TextField } from '@/components/ui'
import { THRESHOLD_LIMITS, parseWhole, type ThresholdKey, type Thresholds } from './api'

/** The thresholds as typed. */
export type ThresholdValues = Record<ThresholdKey, string>
export type ThresholdErrors = Partial<Record<ThresholdKey, string>>

const FIELDS: { key: ThresholdKey; label: string; unit: string; hint: string }[] = [
  { key: 'speed_limit_kmh', label: 'Speed limit', unit: 'km/h', hint: 'Exactly the limit is not speeding.' },
  { key: 'speeding_pings', label: 'Speeding after', unit: 'pings', hint: 'In a row over the limit. A ping comes about every 10 s.' },
  { key: 'clear_pings', label: 'Cleared after', unit: 'pings', hint: 'In a row at or under the limit.' },
  { key: 'idle_minutes', label: 'Idling after', unit: 'min', hint: 'At 0 km/h with the engine not reported off.' },
  { key: 'route_deviation_m', label: 'Off route beyond', unit: 'm', hint: 'From the trip’s road. GPS drifts 10 to 50 m.' },
  { key: 'route_deviation_pings', label: 'Off route after', unit: 'pings', hint: 'In a row that far out. Cleared like speeding.' },
]

export const toValues = (t: Thresholds): ThresholdValues => ({
  speed_limit_kmh: String(t.speed_limit_kmh),
  speeding_pings: String(t.speeding_pings),
  clear_pings: String(t.clear_pings),
  idle_minutes: String(t.idle_minutes),
  route_deviation_m: String(t.route_deviation_m),
  route_deviation_pings: String(t.route_deviation_pings),
})

export function validateThresholds(v: ThresholdValues): { errors: ThresholdErrors; thresholds: Thresholds | null } {
  const errors: ThresholdErrors = {}
  const out: Partial<Thresholds> = {}
  for (const { key } of FIELDS) {
    const parsed = parseWhole(v[key], THRESHOLD_LIMITS[key].min, THRESHOLD_LIMITS[key].max)
    if (parsed.ok) out[key] = parsed.value
    else errors[key] = parsed.error
  }
  return { errors, thresholds: Object.keys(errors).length ? null : (out as Thresholds) }
}

export const sameThresholds = (v: ThresholdValues, t: Thresholds) => FIELDS.every(({ key }) => v[key].trim() === String(t[key]))

/** The speeding, idling and route deviation thresholds, two to a row from small screens up. */
export function ThresholdFields({ values, errors, onChange, idPrefix }: { values: ThresholdValues; errors: ThresholdErrors; onChange: (key: ThresholdKey, value: string) => void; idPrefix?: string }) {
  return (
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
  )
}
