import { useState } from 'react'
import { FuelDisplay, FuelInput, MoneyDisplay, MoneyInput, STATUSES, StatusBadge } from '@/components/shared'

// Dev-only examples page (/dev/ui): every shared component in each state, so a
// change can be checked by eye without a Storybook. Not included in the
// production build (see AppRouter).
export default function UiExamples() {
  const [price, setPrice] = useState<number | null>(14999)
  const [litres, setLitres] = useState<number | null>(23500)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-semibold text-fms-primary">Shared UI examples</h1>

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
    </main>
  )
}
