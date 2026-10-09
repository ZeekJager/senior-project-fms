import { AlertCircle, Info, Mail, Phone } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, cn, Drawer, SelectField, TextField, useToast } from '@/components/ui'
import type { Depot } from '@/features/depots'
import { ApiError } from '@/lib/api/errors'
import { useCreateDriver, useUpdateDriver } from './api'
import { API_FIELDS, EMPTY_FORM, changedFields, formFromDriver, validateDriverForm, type FieldErrors, type FieldName, type DriverFormValues } from './driverForm'
import { LICENSE_CATEGORY_GROUPS, type Driver, type LicenseCategory } from './types'

interface DriverFormDrawerProps {
  open: boolean
  onClose: () => void
  /** Null: add a new driver (and their account). */
  driver: Driver | null
  depots: Depot[]
  defaultDepotId?: string
}

const CONFLICT_MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this driver while you were editing. Close the panel to see their changes, then edit again.',
  CONFLICT_INVALID_STATE_TRANSITION: 'This driver has been retired. Reinstate them before changing their licence.',
  NOT_FOUND: 'This driver no longer exists or is outside your depots.',
}

/**
 * S-05 add / edit. Adding creates the driver's user account (driver role, no
 * password yet) and the licence in one request. Licence changes go through
 * this panel only, never inline in the table, so each is one audited edit.
 */
export function DriverFormDrawer({ open, onClose, driver, depots, defaultDepotId }: DriverFormDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const [values, setValues] = useState<DriverFormValues>(EMPTY_FORM)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const create = useCreateDriver()
  const update = useUpdateDriver()
  const saving = create.isPending || update.isPending
  const creating = driver === null

  useEffect(() => {
    if (!open) return
    setValues(driver ? formFromDriver(driver) : { ...EMPTY_FORM, depot_id: defaultDepotId ?? (depots.length === 1 ? depots[0].id : '') })
    setErrors({})
    setFormError(null)
  }, [open, driver, defaultDepotId, depots])

  function set<K extends FieldName>(field: K, value: DriverFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }))
    if (errors[field]) {
      setErrors((current) => {
        const next = { ...current }
        delete next[field]
        return next
      })
    }
  }

  function toggleCategory(category: LicenseCategory) {
    const has = values.license_categories.includes(category)
    set('license_categories', has ? values.license_categories.filter((c) => c !== category) : [...values.license_categories, category])
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setFormError(null)
    const { errors: found, input } = validateDriverForm(values, creating)
    setErrors(found)
    if (!input) return
    try {
      if (driver) {
        const patch = changedFields(input, driver)
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: driver.id, version: driver.version, patch })
        toast({ title: 'Changes saved', description: `${driver.full_name}’s record is up to date.` })
      } else {
        await create.mutateAsync(input)
        toast({ title: 'Driver added', description: `${input.account.full_name} can be assigned to trips once their licence is valid.` })
      }
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  function showServerError(err: unknown) {
    if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
    if (err.code === 'CONFLICT_DUPLICATE_LICENSE') {
      return setErrors({ license_number: 'Another driver already has this licence number.' })
    }
    if (err.code === 'CONFLICT_DUPLICATE' && err.details.some((d) => d.field === 'account.email')) {
      return setErrors({ email: 'An account with this email already exists.' })
    }
    const fieldErrors: FieldErrors = {}
    for (const detail of err.details) {
      const field = detail.field ? API_FIELDS[detail.field] : undefined
      if (field) fieldErrors[field] = detail.reason === 'references_missing_record' ? 'Choose one of your depots.' : 'Check this value.'
    }
    if (Object.keys(fieldErrors).length > 0) return setErrors(fieldErrors)
    setFormError(CONFLICT_MESSAGES[err.code] ?? `The driver could not be saved (${err.code}).`)
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={driver ? `Edit ${driver.full_name}` : 'Add driver'}
      description={driver ? 'Licence and depot changes are saved to the audit log.' : 'Creates the driver’s account and records their licence.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {driver ? 'Save changes' : 'Add driver'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-6">
        <div role="alert">
          {formError && (
            <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
        </div>

        <Section title="Person">
          {creating ? (
            <>
              <TextField label="Full name" autoComplete="off" value={values.full_name} onChange={(e) => set('full_name', e.target.value)} error={errors.full_name} />
              <TextField
                label="Email"
                type="email"
                autoComplete="off"
                value={values.email}
                onChange={(e) => set('email', e.target.value)}
                error={errors.email}
                hint="Their sign-in name. A password is set up later by an administrator."
              />
              <TextField label="Phone" optional type="tel" value={values.phone} onChange={(e) => set('phone', e.target.value)} error={errors.phone} />
            </>
          ) : (
            driver && (
              <div className="rounded-card border border-line bg-surface-muted p-4">
                <p className="font-medium text-ink">{driver.full_name}</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-muted">
                  <Mail className="h-3.5 w-3.5" aria-hidden="true" /> {driver.email}
                </p>
                {driver.phone && (
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-muted">
                    <Phone className="h-3.5 w-3.5" aria-hidden="true" /> {driver.phone}
                  </p>
                )}
                <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-subtle">
                  <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Name and contact details belong to the user account and change in user administration.
                </p>
              </div>
            )
          )}
        </Section>

        <Section title="Licence">
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField
              label="Licence number"
              autoComplete="off"
              spellCheck={false}
              value={values.license_number}
              onChange={(e) => set('license_number', e.target.value)}
              error={errors.license_number}
            />
            <TextField
              label="Expires on"
              type="date"
              alwaysFloat
              value={values.license_expiry}
              onChange={(e) => set('license_expiry', e.target.value)}
              error={errors.license_expiry}
            />
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">
              Categories <span className="font-normal text-ink-subtle">(optional)</span>
            </legend>
            <div className="space-y-2">
              {LICENSE_CATEGORY_GROUPS.map((group) => (
                <div key={group.label} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-28 shrink-0 text-xs text-ink-subtle">{group.label}</span>
                  {group.categories.map((c) => {
                    const on = values.license_categories.includes(c)
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleCategory(c)}
                        className={cn(
                          'focus-ring h-8 min-w-[44px] rounded-[10px] border px-2.5 text-xs font-semibold transition-all duration-150 ease-smooth',
                          on
                            ? 'border-brand/40 bg-brand-soft text-brand-ink shadow-soft'
                            : 'border-line-strong bg-surface text-ink-muted hover:border-ink-subtle/50 hover:text-ink',
                        )}
                      >
                        {c}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-subtle">They decide which vehicle types the driver may be dispatched with.</p>
          </fieldset>
        </Section>

        <Section title="Employment">
          <SelectField
            label="Home depot"
            value={values.depot_id}
            onChange={(e) => set('depot_id', e.target.value)}
            error={errors.depot_id}
            placeholder="Choose a depot…"
            options={depots.map((d) => ({ value: d.id, label: d.name }))}
          />
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField
              label="Hired on"
              optional
              type="date"
              alwaysFloat
              value={values.hire_date}
              onChange={(e) => set('hire_date', e.target.value)}
              error={errors.hire_date}
            />
            <TextField
              label="Emergency phone"
              optional
              type="tel"
              value={values.emergency_phone}
              onChange={(e) => set('emergency_phone', e.target.value)}
              error={errors.emergency_phone}
            />
          </div>
        </Section>
      </form>
    </Drawer>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</legend>
      {children}
    </fieldset>
  )
}
