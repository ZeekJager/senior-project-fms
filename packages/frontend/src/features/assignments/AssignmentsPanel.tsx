import { AlertCircle, Link2, UserRound, Truck } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { ConfirmDialog, EmptyState, ErrorState } from '@/components/shared'
import { Badge, Button, Card, Drawer, SelectField, Skeleton, TextAreaField, TextField, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { ApiError } from '@/lib/api/errors'
import { useAssignments, useCandidates, useCreateAssignment, useEndAssignment, type Assignment, type AssignmentSubject, type AssignmentType } from './api'

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Addis_Ababa' })
const day = (iso: string) => dayFormat.format(new Date(iso))
/** A date picked in the form: that Addis Ababa day's start. */
const dayStart = (date: string) => new Date(`${date}T00:00:00+03:00`).toISOString()

/** Who or what is on the other side of an assignment, seen from the subject. */
const other = (a: Assignment, subject: AssignmentSubject) => (subject.kind === 'vehicle' ? (a.driver.full_name ?? 'A driver') : a.vehicle.registration_number)

function Period({ a }: { a: Assignment }) {
  return (
    <span className="tabular">
      {day(a.start_at)} – {a.end_at ? day(a.end_at) : 'until ended'}
    </span>
  )
}

/**
 * A vehicle's regular drivers, or a driver's regular vehicles (FMS-77, docs/driver-vehicle-assignments.md): who it is
 * now, and the history, newest first. assignment:write gives a new one or ends the current one.
 */
export function AssignmentsPanel({ subject, depotId, name }: { subject: AssignmentSubject; depotId: string | null; name: string }) {
  const { hasPermission } = useAuth()
  const canWrite = hasPermission('assignment:write')
  const [page, setPage] = useState(1)
  const list = useAssignments(subject, page)
  const [assigning, setAssigning] = useState(false)
  const [ending, setEnding] = useState<Assignment | null>(null)
  const end = useEndAssignment()
  const { toast } = useToast()
  const [endError, setEndError] = useState<string | null>(null)
  const noun = subject.kind === 'vehicle' ? 'driver' : 'vehicle'

  const items = list.data?.items ?? []
  const current = items.filter((a) => a.current)

  async function confirmEnd() {
    if (!ending) return
    setEndError(null)
    try {
      await end.mutateAsync(ending.id)
      toast({ title: 'Assignment ended', description: `${other(ending, subject)} is no longer ${subject.kind === 'vehicle' ? 'on' : 'driving'} ${name}.` })
      setEnding(null)
    } catch (err) {
      setEndError(err instanceof ApiError ? `It could not be ended (${err.code}).` : 'Could not reach the server. Try again.')
    }
  }

  return (
    <section aria-labelledby="assignments-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="assignments-heading" className="text-base font-semibold text-ink">
            {subject.kind === 'vehicle' ? 'Regular drivers' : 'Regular vehicles'}
          </h2>
          <p className="text-sm text-ink-muted">
            {subject.kind === 'vehicle' ? 'Who normally drives this vehicle, apart from trips.' : 'What this driver normally drives, apart from trips.'}
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setAssigning(true)} leadingIcon={<Link2 className="h-4 w-4" />}>
            Assign {noun}
          </Button>
        )}
      </div>

      {list.isPending ? (
        <Card className="space-y-3 p-4" aria-busy="true">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
      ) : list.isError ? (
        <ErrorState error={list.error} heading="The assignments could not be loaded" onRetry={() => void list.refetch()} />
      ) : items.length === 0 && page === 1 ? (
        <EmptyState
          icon={subject.kind === 'vehicle' ? <UserRound /> : <Truck />}
          heading={`No regular ${noun}`}
          description={`${name} has never had a regular ${noun}.`}
          action={canWrite ? <Button onClick={() => setAssigning(true)}>Assign {noun}</Button> : undefined}
        />
      ) : (
        <Card className="divide-y divide-line">
          {current.length === 0 && page === 1 && <p className="px-4 py-3 text-sm text-ink-muted">No regular {noun} now.</p>}
          <ul aria-label="Assignments">
            {items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1 font-medium text-ink">{other(a, subject)}</span>
                <Badge tone={a.assignment_type === 'primary' ? 'info' : 'neutral'}>{a.assignment_type === 'primary' ? 'Primary' : 'Temporary'}</Badge>
                {a.current ? <Badge tone="success">Current</Badge> : <span className="text-ink-subtle">{a.status === 'active' ? 'Starts later' : 'Ended'}</span>}
                <span className="text-ink-muted">
                  <Period a={a} />
                </span>
                {canWrite && a.status === 'active' && (
                  <Button size="sm" variant="secondary" onClick={() => setEnding(a)} aria-label={`End: ${other(a, subject)}`}>
                    End
                  </Button>
                )}
                {a.notes && <p className="basis-full text-ink-subtle">{a.notes}</p>}
              </li>
            ))}
          </ul>
          {list.data && list.data.meta.total_pages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 text-sm text-ink-muted">
              <span>
                Page {page} of {list.data.meta.total_pages}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                  Newer
                </Button>
                <Button size="sm" variant="secondary" disabled={page >= list.data.meta.total_pages} onClick={() => setPage((p) => p + 1)}>
                  Older
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <AssignDrawer open={assigning} onClose={() => setAssigning(false)} subject={subject} depotId={depotId} name={name} />
      <ConfirmDialog
        open={ending !== null}
        onClose={() => {
          setEnding(null)
          setEndError(null)
        }}
        title="End this assignment?"
        message={ending ? `${other(ending, subject)} stops being ${name}'s ${ending.assignment_type === 'primary' ? 'regular' : 'temporary'} ${noun} now. It stays in the history.` : ''}
        action="End assignment"
        onConfirm={confirmEnd}
        busy={end.isPending}
        error={endError}
        tone="default"
      />
    </section>
  )
}

interface Values {
  other: string
  type: AssignmentType
  starts: string
  ends: string
  notes: string
}
const EMPTY: Values = { other: '', type: 'primary', starts: '', ends: '', notes: '' }

/** Give the subject a driver or a vehicle of its depot: primary (one at a time) or temporary (with an end). */
function AssignDrawer({ open, onClose, subject, depotId, name }: { open: boolean; onClose: () => void; subject: AssignmentSubject; depotId: string | null; name: string }) {
  const formId = useId()
  const { toast } = useToast()
  const create = useCreateAssignment()
  const pick = subject.kind === 'vehicle' ? 'driver' : 'vehicle'
  const candidates = useCandidates(pick, depotId, open)
  const [values, setValues] = useState<Values>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setValues(EMPTY)
    setErrors({})
    setFormError(null)
  }, [open])

  const set = <K extends keyof Values>(field: K, value: Values[K]) => {
    setValues((v) => ({ ...v, [field]: value }))
    setErrors((e) => ({ ...e, [field]: undefined }))
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (create.isPending) return
    setFormError(null)
    const found: Partial<Record<keyof Values, string>> = {}
    if (!values.other) found.other = `Choose a ${pick}.`
    if (values.type === 'temporary' && !values.ends) found.ends = 'A temporary assignment needs an end.'
    if (values.ends && values.starts && values.ends <= values.starts) found.ends = 'After the start.'
    setErrors(found)
    if (Object.keys(found).length > 0) return
    try {
      const saved = await create.mutateAsync({
        driver_id: subject.kind === 'driver' ? subject.id : values.other,
        vehicle_id: subject.kind === 'vehicle' ? subject.id : values.other,
        assignment_type: values.type,
        ...(values.starts ? { start_at: dayStart(values.starts) } : {}),
        ...(values.ends ? { end_at: dayStart(values.ends) } : {}),
        ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
      })
      toast({ title: 'Assigned', description: `${saved.driver.full_name ?? 'The driver'} and ${saved.vehicle.registration_number}.` })
      onClose()
    } catch (err) {
      if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
      const reason = err.details[0]?.reason
      if (reason === 'driver_has_primary_vehicle') return setFormError('That driver already has a regular vehicle for that time. End it first, or make this one temporary.')
      if (reason === 'vehicle_has_primary_driver') return setFormError('That vehicle already has a regular driver for that time. End it first, or make this one temporary.')
      if (err.code === 'CONFLICT_DEPOT_MISMATCH') return setFormError('The driver and the vehicle belong to different depots.')
      if (reason === 'driver_retired' || reason === 'vehicle_retired') return setFormError(`A retired ${reason === 'driver_retired' ? 'driver' : 'vehicle'} cannot be assigned.`)
      setFormError(`The assignment could not be saved (${err.code}).`)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Assign a ${pick}`}
      description={`To ${name}. A primary one is the regular ${pick}; a temporary one stands in until its end.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            Assign
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5">
        <div role="alert" className="empty:-mb-5">
          {formError && (
            <div className="flex items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
        </div>
        <SelectField
          label={pick === 'driver' ? 'Driver' : 'Vehicle'}
          value={values.other}
          onChange={(e) => set('other', e.target.value)}
          error={errors.other}
          disabled={candidates.isPending}
          placeholder={candidates.isPending ? 'Loading…' : `Choose a ${pick}`}
          options={candidates.data ?? []}
          hint={candidates.isError ? `The ${pick}s could not be loaded.` : `The active ${pick}s of the same depot.`}
        />
        <SelectField
          label="Kind"
          value={values.type}
          onChange={(e) => set('type', e.target.value as AssignmentType)}
          options={[
            { value: 'primary', label: 'Primary: the regular one' },
            { value: 'temporary', label: 'Temporary: a stand-in until a date' },
          ]}
        />
        <div className="grid gap-x-4 sm:grid-cols-2">
          <TextField label="From" optional type="date" value={values.starts} onChange={(e) => set('starts', e.target.value)} hint="Today if empty." />
          <TextField label="Until" optional={values.type === 'primary'} type="date" value={values.ends} onChange={(e) => set('ends', e.target.value)} error={errors.ends} />
        </div>
        <TextAreaField label="Notes" optional rows={2} value={values.notes} onChange={(e) => set('notes', e.target.value)} maxLength={1000} />
      </form>
    </Drawer>
  )
}
