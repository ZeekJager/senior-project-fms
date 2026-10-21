import { AlertCircle, CheckCircle2, CloudUpload, Fuel } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { formatMinor, FuelInput, MoneyInput, OdometerInput } from '@/components/shared'
import { TextField } from '@/components/ui'
import { QUEUE_FULL_MESSAGE, QueueFullError } from '@/lib/offlineQueue'
import { useOfflineQueue } from '@/pwa/OfflineQueue'
import { useTripVehicle, useWorkingTrip, type WorkingTrip } from './api'
import { centsPerLitre, checkFillUp, fuelLogBody, type FillUp, type FillUpErrors } from './fuelLog'
import { FormHeader, Note, Panel, TripGate, VehicleCard } from './parts'

const litres = (ml: number) => `${formatMinor(ml, 3, 2)} L`
const birr = (cents: number) => `ETB ${formatMinor(cents, 2)}`
const km = (tenths: number) => `${formatMinor(tenths, 1)} km`

type Done = { status: 'sent' | 'queued'; fillUp: FillUp }

/**
 * Fuel entry (FMS-40, S-14): what the driver put in at the pump, for the
 * vehicle of their trip. Litres, money and the odometer are typed as text and
 * become whole millilitres, cents and tenths of a km (FuelInput, MoneyInput,
 * OdometerInput), so 23.5 L is sent as 23500, never as a float. Submits
 * through the offline queue (FMS-81): with no signal it waits on the phone.
 */
export function DriverFuel() {
  const [params] = useSearchParams()
  const tripId = params.get('trip')
  const working = useWorkingTrip(tripId)
  const [done, setDone] = useState<Done | null>(null)

  return (
    <div className="space-y-5">
      <FormHeader title="Log fuel" />
      {done ? (
        <Result done={done} onAnother={() => setDone(null)} />
      ) : (
        <TripGate
          state={working}
          tripId={tripId}
          noTrip={{ title: 'No vehicle to fuel', text: 'Fuel is logged for the vehicle of your trip. When dispatch assigns one, it shows here.' }}
        >
          {(trip) => <FuelForm key={trip.id} trip={trip} onDone={setDone} />}
        </TripGate>
      )}
    </div>
  )
}

const EMPTY: FillUp = { quantityMl: null, totalCents: null, odometerTenths: null, station: '' }

function FuelForm({ trip, onDone }: { trip: WorkingTrip & { vehicleId: string }; onDone: (done: Done) => void }) {
  const { submit, full, online } = useOfflineQueue()
  const vehicle = useTripVehicle(trip.vehicleId)
  const [fillUp, setFillUp] = useState<FillUp>(EMPTY)
  const [errors, setErrors] = useState<FillUpErrors>({})
  const [checked, setChecked] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function change(next: Partial<FillUp>) {
    const updated = { ...fillUp, ...next }
    setFillUp(updated)
    setError(null)
    // Once the driver has tried to submit, the messages follow what they type.
    if (checked) setErrors(checkFillUp(updated))
  }

  async function send() {
    const found = checkFillUp(fillUp)
    setChecked(true)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setSending(true)
    setError(null)
    try {
      const result = await submit({
        kind: 'fuel',
        label: `Fuel, ${litres(fillUp.quantityMl!)}, ${vehicle.data?.registration_number ?? trip.routeName ?? 'your vehicle'}`,
        path: '/fuel-logs',
        body: fuelLogBody(fillUp, trip.vehicleId, trip.id),
      })
      if (result.status === 'rejected') {
        setError(`It was not accepted: ${result.rejection.message}`)
        return
      }
      onDone({ status: result.status, fillUp })
    } catch (err) {
      setError(err instanceof QueueFullError ? err.message : 'It could not be saved on this phone. Try again.')
    } finally {
      setSending(false)
    }
  }

  const perLitre = fillUp.quantityMl && fillUp.totalCents !== null && fillUp.quantityMl > 0 ? centsPerLitre(fillUp.totalCents, fillUp.quantityMl) : null

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <VehicleCard trip={trip} />

      <div className="space-y-4 rounded-card border border-line bg-surface p-4 shadow-card">
        <FuelInput label="Litres" value={fillUp.quantityMl} onChange={(quantityMl) => change({ quantityMl })} error={errors.quantity} required />
        <MoneyInput
          label="Total paid"
          value={fillUp.totalCents}
          onChange={(totalCents) => change({ totalCents })}
          error={errors.total}
          hint={perLitre !== null ? `${birr(perLitre)} per litre` : 'From the receipt'}
          required
        />
        <OdometerInput label="Odometer" value={fillUp.odometerTenths} onChange={(odometerTenths) => change({ odometerTenths })} error={errors.odometer} required />
        <TextField
          label="Station"
          optional
          value={fillUp.station}
          onChange={(e) => change({ station: e.target.value })}
          error={errors.station}
          maxLength={255}
          autoComplete="off"
        />
      </div>

      <div className="space-y-3">
        <div role="alert" className="empty:hidden">
          {error && (
            <Note tone="danger" icon={<AlertCircle />}>
              {error}
            </Note>
          )}
        </div>
        {full && !error && (
          <Note tone="danger" icon={<AlertCircle />}>
            {QUEUE_FULL_MESSAGE}
          </Note>
        )}
        <button
          type="submit"
          disabled={sending || full}
          aria-busy={sending}
          className="focus-ring flex h-16 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-lg font-bold text-white shadow-soft transition hover:bg-brand-strong active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {online ? <Fuel className="h-5 w-5" aria-hidden="true" /> : <CloudUpload className="h-5 w-5" aria-hidden="true" />}
          {sending ? 'Sending…' : online ? 'Log fuel' : 'Save fuel log'}
        </button>
        <p className="text-center text-sm text-ink-muted">{online ? 'Sent right away.' : 'No signal: it is kept on this phone and sent when there is signal.'}</p>
      </div>
    </form>
  )
}

function Result({ done, onAnother }: { done: Done; onAnother: () => void }) {
  const sent = done.status === 'sent'
  const { quantityMl, totalCents, odometerTenths } = done.fillUp
  return (
    <div className="space-y-4">
      <Panel icon={sent ? <CheckCircle2 /> : <CloudUpload />} title={sent ? 'Fuel logged' : 'Saved on this phone'} tone={sent ? 'success' : 'neutral'}>
        {`${litres(quantityMl!)} for ${birr(totalCents!)} at ${km(odometerTenths!)}.`}{' '}
        {sent ? '' : 'It is sent as soon as the phone has signal. Until then it shows in the badge at the top.'}
      </Panel>
      <Link to="/driver" className="focus-ring flex h-14 w-full items-center justify-center rounded-2xl bg-brand text-lg font-semibold text-white shadow-soft hover:bg-brand-strong">
        Back to My day
      </Link>
      <button type="button" onClick={onAnother} className="focus-ring flex h-12 w-full items-center justify-center rounded-2xl text-base font-medium text-ink-muted hover:bg-surface">
        Log another fill-up
      </button>
    </div>
  )
}
