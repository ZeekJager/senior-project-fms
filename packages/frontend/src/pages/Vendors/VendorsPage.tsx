import { Archive, Pencil, Plus, RotateCcw, Store, Tags } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ConfirmDialog, DataTable, EmptyState, ListToolbar, type Column } from '@/components/shared'
import { Badge, Button, Drawer, FilterSelect, SelectField, TextAreaField, TextField, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots, type Depot } from '@/features/depots'
import { seesEveryDepot } from '@/features/service-due'
import {
  VENDOR_PAGE_SIZE,
  VENDOR_TYPES,
  VENDOR_TYPE_LABELS,
  useSaveVendor,
  useSetVendorActive,
  useVendorCounts,
  useVendors,
  type Vendor,
  type VendorFilters,
  type VendorInput,
  type VendorType,
} from '@/features/vendors'
import { ApiError } from '@/lib/api/errors'

function readFilters(params: URLSearchParams): VendorFilters {
  const page = Number.parseInt(params.get('page') ?? '', 10)
  const type = params.get('type') ?? ''
  return {
    status: params.get('view') === 'retired' ? 'retired' : 'active',
    type: (VENDOR_TYPES as readonly string[]).includes(type) ? (type as VendorType) : '',
    search: params.get('q') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  }
}

function writeFilters(f: VendorFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.status === 'retired') p.set('view', 'retired')
  if (f.type) p.set('type', f.type)
  if (f.search) p.set('q', f.search)
  if (f.page > 1) p.set('page', String(f.page))
  return p
}

/**
 * Vendors (FMS-130): the outside garages, dealers, tyre and parts suppliers a work order can name, with its invoice
 * and cost. Fleet-wide or for one depot. Everyone in the workshop reads them; vendor:write adds, edits and retires.
 */
export function VendorsPage() {
  const { hasPermission, session } = useAuth()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const canWrite = hasPermission('vendor:write')
  const everyDepot = seesEveryDepot(session?.roles ?? [])
  const [search, setSearch] = useState(filters.search)

  function update(patch: Partial<VendorFilters>) {
    setParams(writeFilters({ ...filters, page: 1, ...patch }), { replace: true })
  }

  // The search box is typed into freely; the list follows a moment later.
  const applySearch = useRef(update)
  applySearch.current = update
  useEffect(() => {
    if (search === filters.search) return
    const t = setTimeout(() => applySearch.current({ search }), 300)
    return () => clearTimeout(t)
  }, [search, filters.search])

  const list = useVendors(filters)
  const counts = useVendorCounts()
  const depots = useDepots()
  const depotNames = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d.name])), [depots.data])
  const { toast } = useToast()
  const setActive = useSetVendorActive()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Vendor | null>(null)
  const [retiring, setRetiring] = useState<Vendor | null>(null)
  const [retireError, setRetireError] = useState<string | null>(null)

  /** A depot admin sees fleet-wide vendors but changes only their depot's. */
  const editable = (v: Vendor) => canWrite && (v.depot_id !== null || everyDepot)

  function open(vendor: Vendor | null) {
    setEditing(vendor)
    setFormOpen(true)
  }

  async function restore(vendor: Vendor) {
    try {
      await setActive.mutateAsync({ vendor, active: true })
      toast({ title: `${vendor.name} is back`, description: 'Work orders can name it again.' })
    } catch (err) {
      toast({ title: 'Could not bring it back', description: err instanceof ApiError && err.code === 'CONFLICT_DUPLICATE' ? 'An active vendor of that name serves the depot.' : 'Try again.', tone: 'danger' })
    }
  }

  const columns: Column<Vendor>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      cell: (v) => (
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate font-semibold text-ink">
            <span className="truncate">{v.name}</span>
            {!v.is_active && <Badge tone="neutral">Retired</Badge>}
          </p>
          <p className="truncate text-xs text-ink-subtle">
            {VENDOR_TYPE_LABELS[v.vendor_type]} · {v.depot_id === null ? 'Every depot' : (depotNames.get(v.depot_id) ?? 'One depot')}
          </p>
        </div>
      ),
    },
    {
      key: 'contact',
      header: 'Contact',
      width: 'w-[34%]',
      hideBelow: 'md',
      cell: (v) =>
        v.contact_name || v.phone || v.email ? (
          <div className="min-w-0 text-sm">
            <p className="truncate text-ink">{v.contact_name ?? v.phone ?? v.email}</p>
            <p className="tabular truncate text-xs text-ink-subtle">{[v.contact_name ? v.phone : null, v.contact_name || v.phone ? v.email : null].filter(Boolean).join(' · ')}</p>
          </div>
        ) : (
          <span className="text-sm text-ink-subtle">—</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[120px]',
      align: 'right',
      hideBelow: 'sm',
      cell: (v) =>
        !editable(v) ? null : v.is_active ? (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Pencil className="h-3.5 w-3.5" />}
            aria-label={`Edit ${v.name}`}
            onClick={(e) => {
              e.stopPropagation()
              open(v)
            }}
          >
            Edit
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<RotateCcw className="h-3.5 w-3.5" />}
            aria-label={`Restore ${v.name}`}
            loading={setActive.isPending && setActive.variables?.vendor.id === v.id}
            onClick={(e) => {
              e.stopPropagation()
              void restore(v)
            }}
          >
            Restore
          </Button>
        ),
      skeleton: <span />,
    },
  ]

  const filtered = Boolean(filters.type || filters.search)

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Vendors</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">Outside garages, dealers, tyre and parts suppliers that work orders send work to.</p>
        </div>
        {canWrite && (
          <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => open(null)} className="self-start sm:self-auto">
            Add vendor
          </Button>
        )}
      </header>

      <section aria-label="Vendor list">
        <DataTable
          toolbar={
            <ListToolbar
              views={{
                label: 'Vendor views',
                value: filters.status,
                options: [
                  { value: 'active', label: 'Active', count: counts.data?.active, isLoading: counts.isPending, hint: 'Work orders can name them' },
                  { value: 'retired', label: 'Retired', count: counts.data?.retired, isLoading: counts.isPending, archived: true, hint: 'Kept on the work orders that named them' },
                ],
                onChange: (status) => update({ status }),
              }}
              search={{ label: 'Search vendors', placeholder: 'Name or contact', value: search, onChange: setSearch, busy: list.isFetching && search !== '' }}
              onClear={
                filtered
                  ? () => {
                      setSearch('')
                      update({ type: '', search: '' })
                    }
                  : undefined
              }
            >
              <FilterSelect
                label="Type"
                icon={<Tags />}
                value={filters.type}
                emptyValue=""
                options={[{ value: '', label: 'All types' }, ...VENDOR_TYPES.map((t) => ({ value: t, label: VENDOR_TYPE_LABELS[t] }))]}
                onChange={(type) => update({ type: type as VendorType | '' })}
              />
            </ListToolbar>
          }
          caption="Vendors"
          rowHeight="stacked"
          columns={columns}
          data={list.data?.vendors}
          rowKey={(v) => v.id}
          rowLabel={(v) => v.name}
          onRowClick={(v) => (editable(v) && v.is_active ? open(v) : undefined)}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          pagination={
            list.data ? { page: filters.page, pageSize: VENDOR_PAGE_SIZE, totalItems: list.data.meta.total_items, onPageChange: (page) => setParams(writeFilters({ ...filters, page })) } : undefined
          }
          emptyState={
            filtered ? (
              <EmptyState icon={<Store />} heading="No vendors match" description="Try another name or type." />
            ) : filters.status === 'retired' ? (
              <EmptyState icon={<Store />} heading="No retired vendors" description="Vendors you retire are kept here, on the work orders that named them." />
            ) : (
              <EmptyState
                icon={<Store />}
                heading="No vendors yet"
                description="Add the garages and suppliers you send work to, and work orders can record their invoices and costs."
                action={
                  canWrite && (
                    <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => open(null)}>
                      Add vendor
                    </Button>
                  )
                }
              />
            )
          }
        />
      </section>

      <VendorFormDrawer
        open={formOpen}
        onClose={() => setFormOpen(false)}
        vendor={editing}
        depots={depots.data ?? []}
        everyDepot={everyDepot}
        homeDepotId={session?.user.depot_id ?? null}
        onRetire={
          editing
            ? () => {
                setFormOpen(false)
                setRetireError(null)
                setRetiring(editing)
              }
            : undefined
        }
      />
      <ConfirmDialog
        open={retiring !== null}
        onClose={() => setRetiring(null)}
        title={`Retire ${retiring?.name ?? 'this vendor'}?`}
        tone="danger"
        action="Retire vendor"
        busy={setActive.isPending}
        error={retireError}
        message={<p>New work orders can no longer name it. The work orders that already did keep it, with their invoices. You can restore it from the Retired view.</p>}
        onConfirm={async () => {
          if (!retiring) return
          try {
            await setActive.mutateAsync({ vendor: retiring, active: false })
            toast({ title: `${retiring.name} retired` })
            setRetiring(null)
          } catch {
            setRetireError('Could not retire the vendor. Try again.')
          }
        }}
      />
    </div>
  )
}

const EMPTY: VendorInput = { name: '', vendor_type: 'workshop', contact_name: null, phone: null, email: null, depot_id: null, notes: null }

function VendorFormDrawer({
  open,
  onClose,
  vendor,
  depots,
  everyDepot,
  homeDepotId,
  onRetire,
}: {
  open: boolean
  onClose: () => void
  vendor: Vendor | null
  depots: Depot[]
  everyDepot: boolean
  homeDepotId: string | null
  onRetire?: () => void
}) {
  const save = useSaveVendor()
  const { toast } = useToast()
  const [values, setValues] = useState<VendorInput>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof VendorInput, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setErrors({})
    setFormError(null)
    setValues(
      vendor
        ? { name: vendor.name, vendor_type: vendor.vendor_type, contact_name: vendor.contact_name, phone: vendor.phone, email: vendor.email, depot_id: vendor.depot_id, notes: vendor.notes }
        : { ...EMPTY, depot_id: everyDepot ? null : homeDepotId },
    )
  }, [open, vendor, everyDepot, homeDepotId])

  const set = <K extends keyof VendorInput>(key: K, value: VendorInput[K]) => setValues((v) => ({ ...v, [key]: value }))
  const blank = (s: string) => (s.trim() === '' ? null : s)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const next: typeof errors = {}
    if (!values.name.trim()) next.name = 'Give the vendor a name.'
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) next.email = 'Enter an e-mail address like service@garage.et.'
    setErrors(next)
    if (Object.keys(next).length) return
    setFormError(null)
    try {
      await save.mutateAsync({ vendor, input: { ...values, name: values.name.trim() } })
      toast({ title: vendor ? 'Vendor saved' : 'Vendor added', description: values.name.trim() })
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT_DUPLICATE') setErrors({ name: 'An active vendor of that name already serves this depot.' })
      else if (err instanceof ApiError && err.code === 'CONFLICT_CONCURRENT_MODIFICATION') setFormError('Someone else changed this vendor. Close it and open it again.')
      else setFormError(err instanceof ApiError ? `Could not save the vendor (${err.code}).` : 'Could not reach the server. Try again.')
    }
  }

  const depotOptions = [...(everyDepot ? [{ value: '', label: 'Every depot (fleet-wide)' }] : []), ...depots.map((d) => ({ value: d.id, label: d.name }))]

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={vendor ? `Edit ${vendor.name}` : 'Add vendor'}
      description="Work orders name it with its invoice and cost."
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {onRetire ? (
            <Button variant="ghost" leadingIcon={<Archive className="h-4 w-4" />} onClick={onRetire}>
              Retire
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="vendor-form" loading={save.isPending}>
              {vendor ? 'Save vendor' : 'Add vendor'}
            </Button>
          </div>
        </div>
      }
    >
      <form id="vendor-form" onSubmit={submit} className="space-y-1" noValidate>
        {formError && (
          <p role="alert" className="mb-3 rounded-control border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-danger">
            {formError}
          </p>
        )}
        <TextField label="Name" value={values.name} onChange={(e) => set('name', e.target.value)} error={errors.name} maxLength={255} autoComplete="off" />
        <div className="grid gap-x-4 sm:grid-cols-2">
          <SelectField label="Type" value={values.vendor_type} onChange={(e) => set('vendor_type', e.target.value as VendorType)} options={VENDOR_TYPES.map((t) => ({ value: t, label: VENDOR_TYPE_LABELS[t] }))} />
          <SelectField
            label="Serves"
            value={values.depot_id ?? ''}
            onChange={(e) => set('depot_id', e.target.value || null)}
            options={depotOptions}
            hint={everyDepot ? 'Fleet-wide vendors can work on any depot’s vehicles.' : undefined}
          />
        </div>
        <TextField label="Contact person" optional value={values.contact_name ?? ''} onChange={(e) => set('contact_name', blank(e.target.value))} maxLength={255} autoComplete="off" />
        <div className="grid gap-x-4 sm:grid-cols-2">
          <TextField label="Phone" optional type="tel" inputMode="tel" value={values.phone ?? ''} onChange={(e) => set('phone', blank(e.target.value))} maxLength={50} autoComplete="off" />
          <TextField label="E-mail" optional type="email" value={values.email ?? ''} onChange={(e) => set('email', blank(e.target.value))} error={errors.email} maxLength={255} autoComplete="off" />
        </div>
        <TextAreaField label="Notes" optional rows={3} value={values.notes ?? ''} onChange={(e) => set('notes', blank(e.target.value))} maxLength={2000} />
      </form>
    </Drawer>
  )
}
