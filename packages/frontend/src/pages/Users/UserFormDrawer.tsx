import { AlertCircle, Building2, Check, KeyRound, Lock, ShieldAlert } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/shared'
import { Button, cn, Drawer, SelectField, Skeleton, TextField, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { ApiError } from '@/lib/api/errors'
import { useCreateUser, useIssuePasswordLink, useRoles, useUpdateUser, type PasswordLink, type User, type UserPatch, type UserStatus } from './api'
import { DEPOT_SCOPED_ROLES, mayAssignRole, needsDepot, roleLabel, STATUS_LABELS } from './roles'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,29}$/

type FieldName = 'full_name' | 'email' | 'phone' | 'depot_id' | 'roles'
type FieldErrors = Partial<Record<FieldName, string>>

interface Values {
  full_name: string
  email: string
  phone: string
  depot_id: string
  roles: string[]
  status: UserStatus
}

const blank: Values = { full_name: '', email: '', phone: '', depot_id: '', roles: [], status: 'active' }

const valuesOf = (u: User): Values => ({
  full_name: u.full_name,
  email: u.email,
  phone: u.phone ?? '',
  depot_id: u.depot_id ?? '',
  roles: [...u.roles],
  status: u.status,
})

const sameRoles = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join()

export interface IssuedLink {
  link: PasswordLink
  name: string
  email: string
  /** Set when the invited account holds the driver role: it still needs a licence profile (the Drivers screen). */
  driverProfile?: { userId: string; depotId: string | null }
}

interface UserFormDrawerProps {
  open: boolean
  /** The account to edit; null to create one. */
  user: User | null
  onClose: () => void
  /** A one-time password link was issued (on create, or from the password section). */
  onLink: (issued: IssuedLink) => void
}

/** Create an account (no password: it gets an invitation link) or edit one: profile, roles, depot, status. */
export function UserFormDrawer({ open, user, onClose, onLink }: UserFormDrawerProps) {
  const formId = useId()
  const { session } = useAuth()
  const { toast } = useToast()
  const roles = useRoles(open)
  const depots = useDepots()
  const create = useCreateUser()
  const update = useUpdateUser()
  const issueLink = useIssuePasswordLink()

  const [values, setValues] = useState<Values>(blank)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmingStatus, setConfirmingStatus] = useState(false)

  useEffect(() => {
    if (!open) return
    setValues(user ? valuesOf(user) : blank)
    setErrors({})
    setFormError(null)
    setConfirmingStatus(false)
  }, [open, user])

  const caller = { roles: session?.roles ?? [], permissions: session?.permissions ?? [] }
  const isSelf = user !== null && user.id === session?.user.id
  const roleMap = useMemo(() => new Map((roles.data ?? []).map((r) => [r.name, r])), [roles.data])
  // Editing an account is as strong as holding its roles (the API's rule): an
  // account with roles beyond the caller's is read-only here.
  const locked =
    user !== null &&
    user.roles.some((name) => {
      const role = roleMap.get(name)
      return role !== undefined && !mayAssignRole(caller, role)
    })
  const saving = create.isPending || update.isPending

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((v) => ({ ...v, [key]: value }))
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }))
  }

  function toggleRole(name: string) {
    set('roles', values.roles.includes(name) ? values.roles.filter((r) => r !== name) : [...values.roles, name])
  }

  function validate(): FieldErrors {
    const e: FieldErrors = {}
    if (!values.full_name.trim()) e.full_name = 'Enter the person’s full name.'
    if (!values.email.trim()) e.email = 'Enter their work email.'
    else if (!EMAIL_PATTERN.test(values.email.trim())) e.email = 'Enter a valid email address, like name@example.com.'
    if (values.phone.trim() && !PHONE_PATTERN.test(values.phone.trim())) e.phone = 'Enter a phone number such as +251 911 234567.'
    if (values.roles.length === 0) e.roles = 'Choose at least one role.'
    if (needsDepot(values.roles) && !values.depot_id) e.depot_id = 'These roles work in one depot: choose their home depot.'
    return e
  }

  function patchOf(u: User): UserPatch {
    const p: UserPatch = {}
    if (values.full_name.trim() !== u.full_name) p.full_name = values.full_name.trim()
    if (values.email.trim().toLowerCase() !== u.email) p.email = values.email.trim()
    if ((values.phone.trim() || null) !== u.phone) p.phone = values.phone.trim() || null
    if ((values.depot_id || null) !== u.depot_id) p.depot_id = values.depot_id || null
    if (!isSelf && !sameRoles(values.roles, u.roles)) p.roles = values.roles
    if (!isSelf && values.status !== u.status) p.status = values.status
    return p
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving || locked) return
    const e = validate()
    setErrors(e)
    setFormError(null)
    if (Object.keys(e).length > 0) return revealFirstError()
    if (user && user.status === 'active' && values.status !== 'active' && !confirmingStatus) {
      setConfirmingStatus(true)
      return
    }
    await save()
  }

  async function save() {
    try {
      if (user) {
        const patch = patchOf(user)
        if (Object.keys(patch).length === 0) {
          onClose()
          return
        }
        const saved = await update.mutateAsync({ id: user.id, patch })
        setConfirmingStatus(false)
        onClose()
        toast(
          patch.status && patch.status !== 'active'
            ? { title: 'Account deactivated', description: `${saved.full_name} has been signed out everywhere.` }
            : { title: 'Changes saved', description: `${saved.full_name}’s account is up to date.` },
        )
      } else {
        const { user: created, link } = await create.mutateAsync({
          email: values.email.trim(),
          full_name: values.full_name.trim(),
          phone: values.phone.trim() || null,
          depot_id: values.depot_id || null,
          roles: values.roles,
        })
        onClose()
        toast({ title: 'Account created', description: `Send ${created.full_name} the invitation link to finish.` })
        onLink({
          link,
          name: created.full_name,
          email: created.email,
          driverProfile: created.roles.includes('driver') ? { userId: created.id, depotId: created.depot_id } : undefined,
        })
      }
    } catch (err) {
      setConfirmingStatus(false)
      showError(err)
    }
  }

  function showError(err: unknown) {
    if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
    if (err.code === 'CONFLICT_DUPLICATE') return setErrors({ email: 'An account with this email already exists.' })
    const fieldErrors: FieldErrors = {}
    for (const d of err.details) {
      const field = d.field?.split('.')[0]
      if (field === 'depot_id') fieldErrors.depot_id = d.reason === 'required' ? 'These roles work in one depot: choose their home depot.' : 'Choose a depot from the list.'
      else if (field === 'email') fieldErrors.email = 'Enter a valid email address, like name@example.com.'
      else if (field === 'phone') fieldErrors.phone = 'Enter a phone number such as +251 911 234567.'
      else if (field === 'full_name') fieldErrors.full_name = 'Enter the person’s full name.'
      else if (field === 'roles' && d.reason === 'references_missing_record') fieldErrors.roles = 'A chosen role no longer exists. Reload the page.'
    }
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors)
      return revealFirstError()
    }
    // Escalation, own roles, last admin: the server's message says what to do.
    setFormError(err.message)
  }

  /** The drawer scrolls: bring the first problem into view (after the errors render) and focus it. */
  function revealFirstError() {
    requestAnimationFrame(() => {
      const target = document.getElementById(formId)?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid]')
      target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      target?.focus({ preventScroll: true })
    })
  }

  async function sendLink() {
    if (!user) return
    try {
      const link = await issueLink.mutateAsync(user.id)
      onLink({ link, name: user.full_name, email: user.email })
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not reach the server. Check your connection and try again.')
    }
  }

  const depotOptions = [
    { value: '', label: needsDepot(values.roles) ? 'Choose a depot' : 'None (every depot)' },
    ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.code ? `${d.name} · ${d.code}` : d.name })),
  ]

  return (
    <>
      <Drawer
        open={open && !confirmingStatus}
        onClose={onClose}
        title={user ? `Edit ${user.full_name}` : 'Invite a user'}
        description={user ? 'Role and status changes are recorded in the audit log.' : 'They get an invitation link to choose their own password.'}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={saving} disabled={locked}>
              {user ? 'Save changes' : 'Create account'}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={onSubmit} noValidate className="space-y-7">
          <div role="alert" className="empty:-mb-6">
            {formError && (
              <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {formError}
              </div>
            )}
          </div>

          {locked && (
            <p className="flex items-start gap-2.5 rounded-control border border-warning/25 bg-warning-soft px-3.5 py-3 text-sm text-warning">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              This account holds a role with permissions you do not have, so only an administrator can change it.
            </p>
          )}

          <fieldset disabled={locked} className="space-y-1">
            <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Person</legend>
            <TextField label="Full name" autoComplete="off" value={values.full_name} onChange={(e) => set('full_name', e.target.value)} error={errors.full_name} />
            <TextField label="Work email" type="email" autoComplete="off" value={values.email} onChange={(e) => set('email', e.target.value)} error={errors.email} />
            <TextField label="Phone" type="tel" optional value={values.phone} onChange={(e) => set('phone', e.target.value)} error={errors.phone} />
          </fieldset>

          <fieldset disabled={locked || isSelf} aria-describedby={`${formId}-roles-message`} data-invalid={errors.roles ? true : undefined}>
            <legend className="mb-3 flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-ink-subtle">
              Roles
              {isSelf && (
                <span className="inline-flex items-center gap-1 normal-case tracking-normal text-ink-subtle">
                  <Lock className="h-3 w-3" aria-hidden="true" /> Another administrator changes your roles
                </span>
              )}
            </legend>
            {roles.isPending ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-[72px]" />
                ))}
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {(roles.data ?? []).map((role) => {
                  const checked = values.roles.includes(role.name)
                  const allowed = mayAssignRole(caller, role)
                  // A role the caller may not grant stays as it is: not addable, not removable.
                  const disabled = !allowed
                  return (
                    <label
                      key={role.name}
                      className={cn(
                        'relative flex cursor-pointer gap-3 rounded-control border p-3 shadow-soft transition-all duration-150 ease-smooth has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand/15',
                        checked ? 'border-brand/50 bg-brand-soft/60' : 'border-line-strong bg-surface hover:border-ink-subtle/50',
                        (disabled || locked || isSelf) && 'cursor-not-allowed opacity-60 hover:border-line-strong',
                      )}
                    >
                      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={() => toggleRole(role.name)} />
                      <span
                        aria-hidden="true"
                        className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors', checked ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface')}
                      >
                        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                          {roleLabel(role.name)}
                          {DEPOT_SCOPED_ROLES.includes(role.name) && <Building2 className="h-3.5 w-3.5 text-ink-subtle" aria-label="One depot" />}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-subtle">
                          {disabled ? (
                            <span className="inline-flex items-center gap-1">
                              <ShieldAlert className="h-3 w-3" aria-hidden="true" /> Needs permissions you do not hold
                            </span>
                          ) : (
                            (role.description ?? `${role.permissions.length} permissions`)
                          )}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            <p id={`${formId}-roles-message`} aria-live="polite" className="mt-1.5 min-h-5 px-1 text-xs text-danger">
              {errors.roles}
            </p>
          </fieldset>

          <fieldset disabled={locked} className="space-y-1">
            <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Access</legend>
            <SelectField
              label="Home depot"
              optional={!needsDepot(values.roles)}
              value={values.depot_id}
              options={depotOptions}
              onChange={(e) => set('depot_id', e.target.value)}
              error={errors.depot_id}
              hint={needsDepot(values.roles) ? 'Dispatchers, drivers, technicians, depot admins and finance clerks see this depot only.' : 'Fleet-wide roles see every depot.'}
            />
            {user && (
              <SelectField
                label="Account status"
                value={values.status}
                disabled={isSelf}
                options={(Object.keys(STATUS_LABELS) as UserStatus[]).map((s) => ({ value: s, label: STATUS_LABELS[s].label }))}
                onChange={(e) => set('status', e.target.value as UserStatus)}
                hint={isSelf ? 'You cannot deactivate your own account.' : 'Any status but Active signs the user out at once and blocks sign-in.'}
              />
            )}
          </fieldset>

          {user && !locked && (
            <section className="rounded-card border border-line bg-surface-muted/60 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <KeyRound className="h-4 w-4 text-ink-subtle" aria-hidden="true" />
                Password
              </h3>
              <p className="mt-1 text-xs text-ink-muted">
                {user.has_password
                  ? 'Passwords are never shown. A reset link lets the user choose a new one and signs them out everywhere.'
                  : 'They have not chosen a password yet. Send a new invitation link if the first one was lost or expired.'}
              </p>
              <Button className="mt-3" size="sm" variant="secondary" loading={issueLink.isPending} onClick={() => void sendLink()}>
                {user.has_password ? 'Create reset link' : 'Create new invitation link'}
              </Button>
            </section>
          )}
        </form>
      </Drawer>

      <ConfirmDialog
        open={confirmingStatus}
        onClose={() => setConfirmingStatus(false)}
        title={`Deactivate ${user?.full_name ?? ''}?`}
        message={
          <>
            Setting the account to <strong className="font-semibold text-ink">{STATUS_LABELS[values.status].label.toLowerCase()}</strong> signs {user?.full_name.split(' ')[0]} out on every device at once, and they can no longer sign in. You can reactivate it later.
          </>
        }
        action="Deactivate account"
        busy={saving}
        onConfirm={save}
      />
    </>
  )
}
