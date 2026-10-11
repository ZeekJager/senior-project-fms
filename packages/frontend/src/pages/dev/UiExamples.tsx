import { Plus, Truck } from 'lucide-react'
import { useState } from 'react'
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorBoundary,
  FuelDisplay,
  FuelInput,
  MoneyDisplay,
  MoneyInput,
  STATUSES,
  StatusBadge,
} from '@/components/shared'
import { Badge, Button, Card, FilterSelect, SelectField, TextField } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'

// Dev-only examples page (/dev/ui): every shared component in each state, so a
// change can be checked by eye without a Storybook. Not included in the
// production build (see AppRouter).
export default function UiExamples() {
  const [price, setPrice] = useState<number | null>(14999)
  const [litres, setLitres] = useState<number | null>(23500)
  const [filter, setFilter] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [page, setPage] = useState(1)
  const [crash, setCrash] = useState(false)
  const pageRows = Array.from({ length: 5 }, (_, i) => {
    const n = (page - 1) * 5 + i + 1
    return { id: String(n), plate: `AA 3-${String(10000 + n)}`, status: n % 4 === 0 ? 'Maintenance' : 'Active' }
  })

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 p-6 sm:p-10">
      <h1 className="text-3xl font-semibold tracking-tight text-ink">Shared UI examples</h1>

      <section aria-labelledby="ui-status" className="flex flex-col gap-2">
        <h2 id="ui-status" className="text-lg font-semibold">
          StatusBadge
        </h2>
        <ul className="flex flex-wrap gap-2">
          {STATUSES.map((status) => (
            <li key={status}>
              <StatusBadge status={status} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ui-display" className="flex flex-col gap-2">
        <h2 id="ui-display" className="text-lg font-semibold">
          MoneyDisplay and FuelDisplay
        </h2>
        <dl className="grid max-w-sm grid-cols-2 gap-2">
          <dt>14999 cents</dt>
          <dd>
            <MoneyDisplay amountMinorUnits={14999} />
          </dd>
          <dt>123456789 cents</dt>
          <dd>
            <MoneyDisplay amountMinorUnits={123456789} />
          </dd>
          <dt>-250 cents</dt>
          <dd>
            <MoneyDisplay amountMinorUnits={-250} />
          </dd>
          <dt>23500 ml</dt>
          <dd>
            <FuelDisplay amountMinorUnits={23500} />
          </dd>
          <dt>23505 ml, 3 decimals</dt>
          <dd>
            <FuelDisplay amountMinorUnits={23505} decimals={3} />
          </dd>
          <dt>Missing value</dt>
          <dd>
            <MoneyDisplay amountMinorUnits={null} />
          </dd>
        </dl>
      </section>

      <section aria-labelledby="ui-inputs" className="flex max-w-sm flex-col gap-2">
        <h2 id="ui-inputs" className="text-lg font-semibold">
          MoneyInput and FuelInput
        </h2>
        <MoneyInput label="Price" value={price} onChange={setPrice} required />
        <p>
          Emitted: <code>{price === null ? 'null' : `${price} cents`}</code>
        </p>
        <FuelInput label="Volume" value={litres} onChange={setLitres} required />
        <p>
          Emitted: <code>{litres === null ? 'null' : `${litres} ml`}</code>
        </p>
        <MoneyInput label="With a form error" value={null} onChange={() => {}} error="Price is required for this vehicle." />
        <MoneyInput label="Disabled" value={5000} onChange={() => {}} disabled />
      </section>

      <section aria-labelledby="ui-buttons" className="flex flex-col gap-3">
        <h2 id="ui-buttons" className="text-lg font-semibold">
          Buttons
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button leadingIcon={<Plus className="h-4 w-4" />}>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm" variant="secondary">
            Small
          </Button>
          <Button size="lg">Large</Button>
        </div>
      </section>

      <section aria-labelledby="ui-fields" className="flex max-w-md flex-col">
        <h2 id="ui-fields" className="mb-3 text-lg font-semibold">
          Floating-label fields
        </h2>
        <TextField label="Make" defaultValue="Isuzu" />
        <TextField label="Model" />
        <TextField label="VIN" optional hint="17 characters, on the chassis plate." />
        <TextField label="Registration number" defaultValue="AA_1" error="Use letters, digits, spaces and hyphens." />
        <TextField label="Consumption" disabled hint="Not used for electric vehicles." trailing={<span className="text-xs">L/100 km</span>} />
        <SelectField label="Fuel" defaultValue="" placeholder="Choose…" options={[{ value: 'diesel', label: 'Diesel' }]} />
      </section>

      <section aria-labelledby="ui-badges" className="flex flex-col gap-3">
        <h2 id="ui-badges" className="text-lg font-semibold">
          Badges and filters
        </h2>
        <div className="flex flex-wrap gap-2">
          <Badge>Neutral</Badge>
          <Badge tone="success" dot>
            Valid
          </Badge>
          <Badge tone="warning" dot>
            Expires in 12 days
          </Badge>
          <Badge tone="danger" dot>
            Expired
          </Badge>
          <Badge tone="info">Info</Badge>
          <Badge tone="brand">Brand</Badge>
        </div>
        <FilterSelect
          label="Status"
          value={filter}
          emptyValue=""
          onChange={setFilter}
          options={[
            { value: '', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'maintenance', label: 'Maintenance' },
          ]}
        />
      </section>

      <section aria-labelledby="ui-states" className="flex flex-col gap-3">
        <h2 id="ui-states" className="text-lg font-semibold">
          Table states, empty state and confirm dialog
        </h2>
        <DataTable
          caption="Loading example"
          columns={[{ key: 'a', header: 'Vehicle', cell: () => null }, { key: 'b', header: 'Status', cell: () => null }]}
          data={undefined}
          rowKey={() => ''}
          isLoading
          skeletonRows={2}
        />
        <DataTable
          caption="Error example"
          columns={[{ key: 'a', header: 'Vehicle', cell: () => null }]}
          data={undefined}
          rowKey={() => ''}
          isLoading={false}
          error={new ApiError(503, 'SERVICE_UNAVAILABLE', 'down', [], 'req-example')}
          onRetry={() => {}}
        />
        <DataTable
          caption="Paging example"
          columns={[
            { key: 'plate', header: 'Vehicle', cell: (r: { plate: string }) => <span className="font-semibold">{r.plate}</span> },
            { key: 'status', header: 'Status', cell: (r: { status: string }) => <Badge tone={r.status === 'Active' ? 'success' : 'warning'}>{r.status}</Badge> },
          ]}
          data={pageRows}
          rowKey={(r) => r.id}
          isLoading={false}
          pagination={{ page, pageSize: 5, totalItems: 23, onPageChange: setPage }}
        />
        <Card>
          <EmptyState icon={<Truck />} heading="No vehicles registered for this depot" description="Add the first vehicle to start tracking it." />
        </Card>
        <Card>
          <ErrorBoundary onReset={() => setCrash(false)}>
            {crash ? <Crash /> : (
              <div className="flex items-center justify-between gap-4 p-5">
                <p className="text-sm text-ink-muted">A render error inside an ErrorBoundary shows the error state instead of a blank page.</p>
                <Button variant="secondary" onClick={() => setCrash(true)}>
                  Throw a render error
                </Button>
              </div>
            )}
          </ErrorBoundary>
        </Card>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Open confirm dialog
          </Button>
          <Button variant="secondary" onClick={() => setDeleting(true)}>
            Type-to-confirm: DELETE
          </Button>
        </div>
        <ConfirmDialog
          open={deleting}
          onClose={() => setDeleting(false)}
          title="Delete 23 archived records?"
          message="This cannot be undone."
          action="Delete records"
          requireTyping="DELETE"
          onConfirm={() => setDeleting(false)}
        />
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title="Decommission AA 3-12345"
          message="Type the plate to confirm."
          action="Decommission vehicle"
          requireTyping="AA 3-12345"
          onConfirm={() => setConfirming(false)}
        />
      </section>
    </main>
  )
}

/** Throws while rendering, for the ErrorBoundary example: an API error, so the request id shows. */
function Crash(): never {
  throw new ApiError(500, 'INTERNAL_SERVER_ERROR', 'Example failure', [], '7f3c2a10-5b1e-4c8e-9d2a-3e4f5a6b7c8d')
}
