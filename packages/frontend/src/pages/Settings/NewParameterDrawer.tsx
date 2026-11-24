import { AlertCircle, Plus, X } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { Button, Drawer, IconButton, SelectField, TextAreaField, TextField, useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { checkDefinition, parseDuration, PARAMETER_TYPES, type ParameterOption, type ParameterRules, type ParameterType } from '@/lib/parameterTypes'
import { ValueInput } from './ValueInput'
import { fromDraft, TYPE_LABELS, useDefineParameter, type Draft } from './registry'

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,79}$/

/** A key from a label: "Report cut-off hour" → report_cut_off_hour. */
export function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 80)
}

interface RuleDrafts {
  min: string
  max: string
  decimals: string
  unit: string
  maxLength: string
  pattern: string
  minItems: string
  maxItems: string
  schema: string
}

const EMPTY_RULES: RuleDrafts = { min: '', max: '', decimals: '', unit: '', maxLength: '', pattern: '', minItems: '', maxItems: '', schema: '' }
const STARTING_OPTIONS: ParameterOption[] = [
  { value: '', label: '' },
  { value: '', label: '' },
]

/** The rules as the API takes them, from what was typed; null for a field that is not a number when it must be. */
function toRules(type: ParameterType, r: RuleDrafts, options: ParameterOption[]): { rules: ParameterRules; errors: Partial<Record<keyof RuleDrafts | 'options', string>> } {
  const rules: ParameterRules = {}
  const errors: Partial<Record<keyof RuleDrafts | 'options', string>> = {}
  const num = (field: keyof RuleDrafts, text: string, whole: boolean, seconds = false): number | undefined => {
    const t = text.trim()
    if (!t) return undefined
    const v = seconds ? parseDuration(t) : Number(t.replace(',', '.'))
    if (v === null || !Number.isFinite(v) || (whole && !Number.isInteger(v))) {
      errors[field] = seconds ? 'A duration, like 15m.' : whole ? 'A whole number.' : 'A number.'
      return undefined
    }
    return v
  }
  if (type === 'integer' || type === 'number' || type === 'duration') {
    const whole = type !== 'number'
    const seconds = type === 'duration'
    const min = num('min', r.min, whole, seconds)
    const max = num('max', r.max, whole, seconds)
    if (min !== undefined) rules.min = min
    if (max !== undefined) rules.max = max
  }
  if (type === 'number') {
    const d = num('decimals', r.decimals, true)
    if (d !== undefined) rules.decimals = d
  }
  if ((type === 'integer' || type === 'number') && r.unit.trim()) rules.unit = r.unit.trim()
  if (type === 'text') {
    const len = num('maxLength', r.maxLength, true)
    if (len !== undefined) rules.max_length = len
    if (r.pattern.trim()) rules.pattern = r.pattern.trim()
  }
  if (type === 'dropdown' || type === 'multi_select') {
    rules.options = options.map((o) => ({ value: o.value.trim(), label: o.label.trim() }))
    if (type === 'multi_select') {
      const min = num('minItems', r.minItems, true)
      const max = num('maxItems', r.maxItems, true)
      if (min !== undefined) rules.min_items = min
      if (max !== undefined) rules.max_items = max
    }
  }
  if (type === 'json' && r.schema.trim()) {
    try {
      rules.schema = JSON.parse(r.schema) as ParameterRules['schema']
    } catch {
      errors.schema = 'Not valid JSON.'
    }
  }
  return { rules, errors }
}

/** A field name of the API's (rules.options.1, rules.min) as this form's. */
function formField(field: string): string {
  if (field.startsWith('rules.options')) return 'options'
  const map: Record<string, string> = {
    'rules.min': 'min',
    'rules.max': 'max',
    'rules.decimals': 'decimals',
    'rules.unit': 'unit',
    'rules.max_length': 'maxLength',
    'rules.pattern': 'pattern',
    'rules.min_items': 'minItems',
    'rules.max_items': 'maxItems',
    'rules.schema': 'schema',
    default_value: 'default',
  }
  return map[field] ?? field
}

interface NewParameterDrawerProps {
  open: boolean
  onClose: () => void
  /** The categories in use, offered as the parameter is typed. */
  categories: readonly string[]
  /** Opens the new parameter once saved. */
  onCreated: (key: string) => void
}

/** Add parameter (S-27, FMS-157, settings:define): a custom parameter with its type, rules and default. */
export function NewParameterDrawer({ open, onClose, categories, onCreated }: NewParameterDrawerProps) {
  const define = useDefineParameter()
  const { toast } = useToast()
  const listId = useId()
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [category, setCategory] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<ParameterType>('integer')
  const [ruleDrafts, setRuleDrafts] = useState<RuleDrafts>(EMPTY_RULES)
  const [options, setOptions] = useState<ParameterOption[]>(STARTING_OPTIONS)
  const [defaultDraft, setDefaultDraft] = useState<Draft>('')
  const [secret, setSecret] = useState(false)
  const [permission, setPermission] = useState('')
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLabel('')
    setKey('')
    setKeyTouched(false)
    setCategory('')
    setDescription('')
    setType('integer')
    setRuleDrafts(EMPTY_RULES)
    setOptions(STARTING_OPTIONS)
    setDefaultDraft('')
    setSecret(false)
    setPermission('')
    setErrors({})
    setFailure(null)
  }, [open])

  const { rules } = useMemo(() => toRules(type, ruleDrafts, options), [type, ruleDrafts, options])
  const choosing = type === 'dropdown' || type === 'multi_select'
  const canBeSecret = type === 'text' || type === 'email' || type === 'url' || type === 'json'

  const setRule = (field: keyof RuleDrafts, value: string) => {
    setRuleDrafts((r) => ({ ...r, [field]: value }))
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }))
  }

  function onTypeChange(next: ParameterType) {
    setType(next)
    setRuleDrafts(EMPTY_RULES)
    setDefaultDraft(next === 'boolean' ? 'false' : next === 'multi_select' ? [] : '')
    if (!(next === 'text' || next === 'email' || next === 'url' || next === 'json')) setSecret(false)
    setErrors({})
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (define.isPending) return
    setFailure(null)
    const found: Record<string, string> = {}
    const finalKey = (keyTouched ? key : keyFromLabel(label)).trim()
    if (!label.trim()) found.label = 'Name it.'
    if (!KEY_PATTERN.test(finalKey)) found.key = 'Lower-case letters, digits and _, starting with a letter; 2 to 80.'
    if (!category.trim()) found.category = 'Choose or type a category.'
    const built = toRules(type, ruleDrafts, options)
    Object.assign(found, built.errors)
    const parsedDefault = fromDraft(type, built.rules, defaultDraft)
    if (Object.keys(built.errors).length === 0) {
      for (const p of checkDefinition(type, built.rules, parsedDefault.ok ? parsedDefault.value : null)) {
        const field = formField(p.field)
        found[field] ??= field === 'default' && !parsedDefault.ok ? parsedDefault.error : p.message
      }
    }
    setErrors(found)
    if (Object.keys(found).length || !parsedDefault.ok) return
    try {
      const created = await define.mutateAsync({
        key: finalKey,
        label: label.trim(),
        category: category.trim(),
        description: description.trim(),
        type,
        default_value: parsedDefault.value,
        rules: built.rules,
        is_enabled: true,
        is_secret: secret,
        required_permission: permission.trim() || null,
      })
      toast({ title: `${created.label} added`, description: `Code reads it as settings.get('${created.key}').` })
      onCreated(created.key)
    } catch (err) {
      if (err instanceof ApiError && err.details.length) {
        const fromServer: Record<string, string> = {}
        for (const d of err.details) if (d.field) fromServer[formField(d.field)] = d.reason === 'key_taken' ? 'Already used by another parameter.' : err.message
        setErrors(fromServer)
      }
      setFailure(err instanceof ApiError ? `Not added: ${err.message}` : 'Could not reach the server. Check your connection and try again.')
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Add parameter"
      description="A value code reads with no deployment. It can be changed, disabled or deleted later."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-parameter" loading={define.isPending}>
            Add parameter
          </Button>
        </div>
      }
    >
      <form id="new-parameter" onSubmit={onSubmit} noValidate className="space-y-5" aria-label="New parameter">
        {failure && (
          <div role="alert" className="flex items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {failure}
          </div>
        )}
        <div className="space-y-4">
          <TextField id="np-label" label="Name" value={label} onChange={(e) => setLabel(e.target.value)} error={errors.label} maxLength={120} />
          <TextField
            id="np-key"
            label="Key"
            value={keyTouched ? key : keyFromLabel(label)}
            onChange={(e) => {
              setKeyTouched(true)
              setKey(e.target.value)
            }}
            error={errors.key}
            hint="What code reads it by. Cannot change once added."
            className="[&_input]:font-mono"
            spellCheck={false}
            autoComplete="off"
          />
          <TextField id="np-category" label="Category" value={category} onChange={(e) => setCategory(e.target.value)} error={errors.category} list={listId} maxLength={60} autoComplete="off" />
          <datalist id={listId}>
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <TextAreaField id="np-description" label="What it changes" optional value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
        </div>

        <div className="space-y-4 border-t border-line pt-5">
          <SelectField id="np-type" label="Type" value={type} onChange={(e) => onTypeChange(e.target.value as ParameterType)} options={PARAMETER_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))} />

          {(type === 'integer' || type === 'number' || type === 'duration') && (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="np-min" label={type === 'duration' ? 'Shortest' : 'Smallest'} optional value={ruleDrafts.min} onChange={(e) => setRule('min', e.target.value)} error={errors.min} inputMode={type === 'duration' ? undefined : 'decimal'} />
              <TextField id="np-max" label={type === 'duration' ? 'Longest' : 'Largest'} optional value={ruleDrafts.max} onChange={(e) => setRule('max', e.target.value)} error={errors.max} inputMode={type === 'duration' ? undefined : 'decimal'} />
              {type === 'number' && <TextField id="np-decimals" label="Decimal places at most" optional value={ruleDrafts.decimals} onChange={(e) => setRule('decimals', e.target.value)} error={errors.decimals} inputMode="numeric" />}
              {type !== 'duration' && <TextField id="np-unit" label="Unit" optional value={ruleDrafts.unit} onChange={(e) => setRule('unit', e.target.value)} error={errors.unit} hint="Like km, %, min." maxLength={20} />}
            </div>
          )}
          {type === 'text' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="np-maxlength" label="Longest, in characters" optional value={ruleDrafts.maxLength} onChange={(e) => setRule('maxLength', e.target.value)} error={errors.maxLength} inputMode="numeric" />
              <TextField id="np-pattern" label="Pattern" optional value={ruleDrafts.pattern} onChange={(e) => setRule('pattern', e.target.value)} error={errors.pattern} hint="A regular expression the whole value matches." className="[&_input]:font-mono" spellCheck={false} />
            </div>
          )}
          {choosing && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium text-ink">Options</legend>
              {options.map((o, i) => (
                <div key={i} className="flex items-start gap-2">
                  <TextField
                    id={`np-option-${i}-label`}
                    label={`Option ${i + 1}`}
                    value={o.label}
                    onChange={(e) => {
                      const labelText = e.target.value
                      setOptions((all) => all.map((x, j) => (j === i ? { label: labelText, value: x.value && x.value !== keyFromLabel(x.label) ? x.value : keyFromLabel(labelText) || labelText } : x)))
                      if (errors.options) setErrors((er) => ({ ...er, options: undefined }))
                    }}
                    className="flex-1"
                    maxLength={120}
                  />
                  <IconButton
                    label={`Remove option ${i + 1}`}
                    icon={<X className="h-4 w-4" />}
                    variant="ghost"
                    onClick={() => setOptions((all) => all.filter((_, j) => j !== i))}
                    disabled={options.length <= (type === 'dropdown' ? 2 : 1)}
                    className="mt-1.5"
                  />
                </div>
              ))}
              {errors.options && <p className="text-xs text-danger">{errors.options}</p>}
              <Button type="button" variant="secondary" size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOptions((all) => [...all, { value: '', label: '' }])} disabled={options.length >= 100}>
                Add option
              </Button>
              {type === 'multi_select' && (
                <div className="grid gap-4 pt-2 sm:grid-cols-2">
                  <TextField id="np-minitems" label="Choose at least" optional value={ruleDrafts.minItems} onChange={(e) => setRule('minItems', e.target.value)} error={errors.minItems} inputMode="numeric" />
                  <TextField id="np-maxitems" label="Choose at most" optional value={ruleDrafts.maxItems} onChange={(e) => setRule('maxItems', e.target.value)} error={errors.maxItems} inputMode="numeric" />
                </div>
              )}
            </fieldset>
          )}
          {type === 'json' && (
            <TextAreaField
              id="np-schema"
              label="JSON Schema"
              optional
              value={ruleDrafts.schema}
              onChange={(e) => setRule('schema', e.target.value)}
              error={errors.schema}
              hint="type, enum, minimum, maximum, minLength, maxLength, pattern, items, required, properties, additionalProperties and the like."
              rows={5}
              className="[&_textarea]:font-mono [&_textarea]:text-xs"
              spellCheck={false}
            />
          )}

          <ValueInput
            id="np-default"
            label="Default"
            type={type}
            rules={rules}
            draft={type === 'multi_select' && !Array.isArray(defaultDraft) ? [] : defaultDraft}
            onChange={(d) => {
              setDefaultDraft(d)
              if (errors.default) setErrors((e) => ({ ...e, default: undefined }))
            }}
            error={errors.default}
            hint="What it answers with until it is changed, and while it is disabled."
          />
        </div>

        <div className="space-y-4 border-t border-line pt-5">
          {canBeSecret && (
            <ValueInput
              id="np-secret"
              label="Secret"
              type="boolean"
              rules={{}}
              draft={secret ? 'true' : 'false'}
              onChange={() => setSecret((s) => !s)}
              hint="A key or password: never shown or exported once saved, masked in the history and the audit log."
            />
          )}
          <TextField
            id="np-permission"
            label="Also needs permission"
            optional
            value={permission}
            onChange={(e) => setPermission(e.target.value)}
            error={errors.required_permission}
            hint="Besides settings:write, to change its value. Like backup:write."
            className="[&_input]:font-mono"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </form>
    </Drawer>
  )
}

