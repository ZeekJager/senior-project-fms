import { BadgeCheck, Hourglass, Play, Plus, Store, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { MoneyDisplay } from '@/components/shared'
import { Badge, Button, IconButton, SelectField, TextField, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { formatDate } from '@/features/documents/expiry'
import { VENDOR_TYPE_LABELS, useActiveVendors } from '@/features/vendors'
import { ApiError } from '@/lib/api/errors'
import {
  useAddLabour,
  useAddTask,
  useApproveOrder,
  useOrderTechnicians,
  useRemoveLabour,
  useRemoveTask,
  useSetOrderVendor,
  useStartRequest,
  useUpdateTask,
  type MaintenanceRecord,
  type TaskStatus,
  type WorkOrder,
} from './api'
import { COMPONENT_LABELS } from './failures'

const TASK_STATUS_LABELS: Record<TaskStatus, string> = { pending: 'To do', in_progress: 'Doing', done: 'Done', skipped: 'Skipped' }
const TASK_TONES: Record<TaskStatus, 'neutral' | 'info' | 'success'> = { pending: 'neutral', in_progress: 'info', done: 'success', skipped: 'neutral' }

/** Labour is booked on work under way; tasks and the vendor change on requests too. */
const PLAN_STATUSES = ['requested', 'scheduled', 'open', 'in_progress']
const WORK_STATUSES = ['scheduled', 'open', 'in_progress']

/** Today in Addis Ababa (UTC+3 all year), YYYY-MM-DD: labour is never booked on a day to come. */
function addisToday(): string {
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
}

const hoursText = (h: number) => `${h.toLocaleString('en-US', { maximumFractionDigits: 2 })} h`

function problem(err: unknown, what: string): string {
  if (err instanceof ApiError) {
    const reason = err.details?.[0]?.reason
    if (reason === 'approval_required') return 'This request is above the approval threshold: it has to be approved first.'
    if (reason === 'in_future') return 'Labour cannot be booked on a day that has not come yet.'
    if (reason === 'references_missing_record') return 'That technician or vendor is not available for this vehicle.'
    if (err.code === 'CONFLICT_CONCURRENT_MODIFICATION') return 'Someone else changed this work order. Close it and open it again.'
    return `Could not ${what} (${err.code}).`
  }
  return 'Could not reach the server. Try again.'
}

/**
 * The work order of a repair record (FMS-130): approval of a request, the tasks it is split into, the hours each
 * technician booked, and the outside vendor with its invoice. Rates and labour costs show for finance roles only.
 */
export function WorkOrderSection({ record, canWrite }: { record: MaintenanceRecord; canWrite: boolean }) {
  const order = record.work_order
  const { hasPermission } = useAuth()
  const canApprove = hasPermission('maintenance:approve')
  const seesRates = hasPermission('labour-rate:read')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [record.id])
  if (!order) return null

  const planEditable = canWrite && PLAN_STATUSES.includes(record.status)
  const labourEditable = canWrite && WORK_STATUSES.includes(record.status)
  const run = async (what: string, action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
      return true
    } catch (err) {
      setError(problem(err, what))
      return false
    }
  }

  return (
    <div className="space-y-6">
      {record.status === 'requested' && <RequestNotice record={record} order={order} canApprove={canApprove} canWrite={canWrite} run={run} />}
      {error && (
        <p role="alert" className="rounded-control border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}
      <Tasks record={record} order={order} editable={planEditable} run={run} />
      <Labour record={record} order={order} editable={labourEditable} seesRates={seesRates} run={run} />
      <VendorBlock record={record} order={order} editable={planEditable} run={run} />
    </div>
  )
}

type Run = (what: string, action: () => Promise<unknown>) => Promise<boolean>

function RequestNotice({ record, order, canApprove, canWrite, run }: { record: MaintenanceRecord; order: WorkOrder; canApprove: boolean; canWrite: boolean; run: Run }) {
  const approve = useApproveOrder()
  const start = useStartRequest()
  const { toast } = useToast()
  const needsApproval = order.approval_required
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-control border border-line bg-surface-muted px-3.5 py-3">
      <p className="flex min-w-0 items-start gap-2 text-sm text-ink">
        <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
        <span>
          <span className="block font-medium">{needsApproval ? 'Waiting for approval' : 'Requested, not started'}</span>
          <span className="block text-ink-muted">
            {needsApproval
              ? 'Its cost is above the approval threshold: a fleet manager or depot admin approves it before work starts.'
              : 'Within the approval threshold: it can start without approval. The vehicle is flagged once work starts.'}
          </span>
        </span>
      </p>
      <div className="flex shrink-0 gap-2">
        {canApprove && (
          <Button
            size="sm"
            leadingIcon={<BadgeCheck className="h-3.5 w-3.5" />}
            loading={approve.isPending}
            onClick={async () => {
              if (await run('approve it', () => approve.mutateAsync({ id: record.id }))) toast({ title: 'Work order approved', description: `${record.registration_number} is flagged for the workshop.` })
            }}
          >
            Approve
          </Button>
        )}
        {canWrite && !needsApproval && (
          <Button size="sm" variant="secondary" leadingIcon={<Play className="h-3.5 w-3.5" />} loading={start.isPending} onClick={() => run('start it', () => start.mutateAsync({ id: record.id, version: record.version }))}>
            Start work
          </Button>
        )}
      </div>
    </div>
  )
}

function Tasks({ record, order, editable, run }: { record: MaintenanceRecord; order: WorkOrder; editable: boolean; run: Run }) {
  const add = useAddTask()
  const update = useUpdateTask()
  const remove = useRemoveTask()
  const [description, setDescription] = useState('')
  const [estimate, setEstimate] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!description.trim()) return
    const hours = estimate.trim() === '' ? null : Number(estimate)
    if (await run('add the task', () => add.mutateAsync({ id: record.id, description: description.trim(), estimated_hours: hours }))) {
      setDescription('')
      setEstimate('')
    }
  }

  return (
    <Block title={`Tasks (${order.tasks.length})`}>
      {order.tasks.length === 0 ? (
        <p className="text-sm text-ink-subtle">{editable ? 'Split the work into the jobs the workshop does.' : 'No tasks.'}</p>
      ) : (
        <ul className="divide-y divide-line rounded-control border border-line">
          {order.tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className={`block text-ink ${t.status === 'skipped' ? 'line-through decoration-ink-subtle' : ''}`}>{t.description}</span>
                <span className="tabular block text-xs text-ink-subtle">
                  {[t.component ? COMPONENT_LABELS[t.component as keyof typeof COMPONENT_LABELS] : null, t.estimated_hours !== null ? `${hoursText(t.estimated_hours)} planned` : null, `${hoursText(t.actual_hours)} booked`]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {editable ? (
                <>
                  <select
                    aria-label={`Status of ${t.description}`}
                    value={t.status}
                    onChange={(e) => run('change the task', () => update.mutateAsync({ id: record.id, task: t, status: e.target.value as TaskStatus }))}
                    className="h-8 rounded-control border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {Object.entries(TASK_STATUS_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <IconButton label={`Remove ${t.description}`} icon={<Trash2 className="h-4 w-4" />} size="sm" onClick={() => run('remove the task', () => remove.mutateAsync({ id: record.id, taskId: t.id }))} />
                </>
              ) : (
                <Badge tone={TASK_TONES[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form onSubmit={submit} className="mt-3 grid grid-cols-[1fr_7rem_auto] items-end gap-2">
          <TextField label="New task" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} autoComplete="off" />
          <TextField label="Planned h" optional type="number" min={0} step={0.25} inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} />
          <Button type="submit" variant="secondary" leadingIcon={<Plus className="h-4 w-4" />} loading={add.isPending} disabled={!description.trim()} className="mb-[1.375rem]">
            Add
          </Button>
        </form>
      )}
    </Block>
  )
}

function Labour({ record, order, editable, seesRates, run }: { record: MaintenanceRecord; order: WorkOrder; editable: boolean; seesRates: boolean; run: Run }) {
  const add = useAddLabour()
  const remove = useRemoveLabour()
  const technicians = useOrderTechnicians(editable ? record.id : null)
  const [form, setForm] = useState({ technician: '', day: addisToday(), hours: '', task: '', rate: '' })
  const total = order.labour.reduce((sum, l) => sum + l.hours, 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const hours = Number(form.hours)
    if (!form.technician || !(hours > 0)) return
    const entry = {
      technician_id: form.technician,
      task_id: form.task || null,
      work_date: form.day,
      hours,
      ...(seesRates && form.rate.trim() !== '' ? { rate_cents: Math.round(Number(form.rate) * 100) } : {}),
    }
    if (await run('book the hours', () => add.mutateAsync({ id: record.id, entry }))) setForm((f) => ({ ...f, hours: '', task: '' }))
  }

  return (
    <Block title={`Labour${order.labour.length ? ` · ${hoursText(total)}` : ''}`}>
      {order.labour.length === 0 ? (
        <p className="text-sm text-ink-subtle">{editable ? 'Book the hours each technician worked on it.' : 'No labour booked.'}</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Labour booked</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-subtle">
              <th className="pb-2 font-medium">Technician</th>
              <th className="pb-2 text-right font-medium">Hours</th>
              {seesRates && <th className="pb-2 text-right font-medium">Cost</th>}
              {editable && <th className="pb-2"><span className="sr-only">Remove</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {order.labour.map((l) => (
              <tr key={l.id}>
                <td className="py-2">
                  <span className="block text-ink">{l.technician_name}</span>
                  <span className="block text-xs text-ink-subtle">
                    {formatDate(l.work_date)}
                    {l.task_id && ` · ${order.tasks.find((t) => t.id === l.task_id)?.description ?? 'a task'}`}
                  </span>
                </td>
                <td className="tabular py-2 text-right">{hoursText(l.hours)}</td>
                {seesRates && (
                  <td className="py-2 text-right">
                    {l.cost_cents !== null && <MoneyDisplay amountMinorUnits={l.cost_cents} />}
                    {l.rate_cents !== null && (
                      <span className="block text-xs text-ink-subtle">
                        <MoneyDisplay amountMinorUnits={l.rate_cents} className="inline" />/h
                      </span>
                    )}
                  </td>
                )}
                {editable && (
                  <td className="w-10 py-2 text-right">
                    <IconButton label={`Remove ${l.technician_name}'s ${hoursText(l.hours)}`} icon={<Trash2 className="h-4 w-4" />} size="sm" onClick={() => run('remove the entry', () => remove.mutateAsync({ id: record.id, entryId: l.id }))} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <form onSubmit={submit} className="mt-3 grid gap-x-3 sm:grid-cols-2">
          <SelectField
            label="Technician"
            value={form.technician}
            onChange={(e) => setForm({ ...form, technician: e.target.value })}
            options={[{ value: '', label: technicians.isPending ? 'Loading…' : 'Choose a technician' }, ...(technicians.data ?? []).map((t) => ({ value: t.id, label: t.full_name }))]}
          />
          <TextField label="Day" type="date" max={addisToday()} value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} />
          <TextField label="Hours" type="number" min={0.25} max={24} step={0.25} inputMode="decimal" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
          {order.tasks.length > 0 ? (
            <SelectField label="Task" optional value={form.task} onChange={(e) => setForm({ ...form, task: e.target.value })} options={[{ value: '', label: 'The whole order' }, ...order.tasks.map((t) => ({ value: t.id, label: t.description }))]} />
          ) : (
            <span className="hidden sm:block" />
          )}
          {seesRates && (
            <TextField label="Rate (ETB/h)" optional type="number" min={0} step={0.01} inputMode="decimal" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} hint="Empty: the workshop's rate in Settings." />
          )}
          <div className="flex items-end justify-end sm:col-span-2">
            <Button type="submit" variant="secondary" leadingIcon={<Plus className="h-4 w-4" />} loading={add.isPending} disabled={!form.technician || !(Number(form.hours) > 0)}>
              Book hours
            </Button>
          </div>
        </form>
      )}
    </Block>
  )
}

function VendorBlock({ record, order, editable, run }: { record: MaintenanceRecord; order: WorkOrder; editable: boolean; run: Run }) {
  const set = useSetOrderVendor()
  const vendors = useActiveVendors(editable)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ vendor: '', invoice: '', cost: '' })
  useEffect(() => {
    setEditing(false)
    setForm({ vendor: order.vendor?.id ?? '', invoice: order.vendor_invoice_ref ?? '', cost: order.vendor_cost_cents ? String(order.vendor_cost_cents / 100) : '' })
  }, [record.id, order.vendor?.id, order.vendor_invoice_ref, order.vendor_cost_cents])
  const options = useMemo(
    () => [{ value: '', label: 'Choose a vendor' }, ...(vendors.data ?? []).map((v) => ({ value: v.id, label: `${v.name} · ${VENDOR_TYPE_LABELS[v.vendor_type]}` }))],
    [vendors.data],
  )

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!form.vendor) return
    const ok = await run('save the vendor', () =>
      set.mutateAsync({ id: record.id, vendor_id: form.vendor, vendor_invoice_ref: form.invoice.trim() || null, vendor_cost_cents: Math.round(Number(form.cost || 0) * 100) }),
    )
    if (ok) setEditing(false)
  }

  return (
    <Block title="Outside vendor">
      {!editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {order.vendor ? (
            <p className="flex min-w-0 items-start gap-2 text-sm">
              <Store className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
              <span>
                <span className="block font-medium text-ink">{order.vendor.name}</span>
                <span className="block text-xs text-ink-subtle">
                  {VENDOR_TYPE_LABELS[order.vendor.vendor_type]}
                  {order.vendor_invoice_ref && ` · Invoice ${order.vendor_invoice_ref}`}
                </span>
              </span>
            </p>
          ) : (
            <p className="text-sm text-ink-subtle">{editable ? 'Done in-house. Add a vendor if an outside garage or supplier did part of it.' : 'Done in-house.'}</p>
          )}
          <div className="flex items-center gap-3">
            {order.vendor && <MoneyDisplay amountMinorUnits={order.vendor_cost_cents} className="font-medium" />}
            {editable && (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                {order.vendor ? 'Change' : 'Add vendor'}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={save} className="space-y-1">
          <SelectField label="Vendor" value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} options={options} hint={vendors.data?.length === 0 ? 'No vendors yet: add them on the Vendors screen.' : undefined} />
          <div className="grid gap-x-3 sm:grid-cols-2">
            <TextField label="Invoice reference" optional value={form.invoice} onChange={(e) => setForm({ ...form, invoice: e.target.value })} maxLength={100} autoComplete="off" />
            <TextField label="Cost (ETB)" type="number" min={0} step={0.01} inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {order.vendor && (
              <Button
                type="button"
                variant="ghost"
                loading={set.isPending}
                onClick={async () => {
                  if (await run('remove the vendor', () => set.mutateAsync({ id: record.id, vendor_id: null, vendor_invoice_ref: null, vendor_cost_cents: 0 }))) setEditing(false)
                }}
              >
                Remove vendor
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={set.isPending} disabled={!form.vendor}>
              Save vendor
            </Button>
          </div>
        </form>
      )}
    </Block>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</h3>
      {children}
    </section>
  )
}
