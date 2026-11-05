import { AlertTriangle } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, Combobox, Drawer, SelectField, TextField, useToast, type ComboboxOption } from '@/components/ui'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { ApiError } from '@/lib/api/errors'
import { useVehicleSearch } from '@/pages/Maintenance/api'
import { useLinkDevice, type Provider } from './api'

type VehicleRef = { id: string; registration_number: string }

/** What the drawer opens with: a device id a provider sent (from the unknown list), or nothing. */
export interface LinkPreset {
  providerId: string
  identifier: string
}

interface Props {
  open: boolean
  onClose: () => void
  providers: Provider[]
  preset: LinkPreset | null
}

const IDENTIFIER = /^[!-~]+$/

/**
 * Link a provider's device to a vehicle (FMS-138): from now on the provider's positions naming the device are the
 * vehicle's, on the live map. A vehicle with another device asks first, then replaces it.
 */
export function LinkDeviceDrawer({ open, onClose, providers, preset }: Props) {
  const { toast } = useToast()
  const link = useLinkDevice()
  const [providerId, setProviderId] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [model, setModel] = useState('')
  const [vehicle, setVehicle] = useState<ComboboxOption<VehicleRef> | null>(null)
  const [vehicleQuery, setVehicleQuery] = useState('')
  const [errors, setErrors] = useState<{ provider?: string; identifier?: string; vehicle?: string; form?: string }>({})
  /** The vehicle's current device, when the server said it has one: asking before replacing it. */
  const [occupied, setOccupied] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setProviderId(preset?.providerId ?? (providers.length === 1 ? providers[0].id : ''))
    setIdentifier(preset?.identifier ?? '')
    setModel('')
    setVehicle(null)
    setVehicleQuery('')
    setErrors({})
    setOccupied(null)
  }, [open, preset, providers])

  const debounced = useDebouncedValue(vehicleQuery, 250)
  const searched = useVehicleSearch(debounced)
  const vehicleOptions = useMemo(
    () =>
      (searched.data ?? [])
        .filter((v) => v.status !== 'retired')
        .map((v): ComboboxOption<VehicleRef> => ({ value: v, key: v.id, label: v.registration_number, detail: `${v.make} ${v.model}${v.year ? ` · ${v.year}` : ''}` })),
    [searched.data],
  )

  async function submit(replace: boolean) {
    const id = identifier.trim()
    const found: typeof errors = {}
    if (!providerId) found.provider = 'Choose the provider whose webhooks name this device.'
    if (!id) found.identifier = 'Enter the device id the provider sends (its IMEI or serial).'
    else if (!IDENTIFIER.test(id)) found.identifier = 'Letters, digits and punctuation only, without spaces.'
    if (!vehicle) found.vehicle = 'Choose the vehicle the device is installed in.'
    setErrors(found)
    if (Object.keys(found).length > 0) return
    try {
      await link.mutateAsync({ provider_id: providerId, device_identifier: id, vehicle_id: vehicle!.value.id, device_model: model.trim() || null, replace })
      toast({ title: 'Device linked', description: `${id} now reports for ${vehicle!.label}. Its next position appears on the live map.` })
      onClose()
    } catch (err) {
      if (!(err instanceof ApiError)) return setErrors({ form: 'Could not reach the server. Try again.' })
      const detail = err.details[0]
      if (detail?.reason === 'vehicle_has_device') return setOccupied(err.message.match(/device (\S+)\./)?.[1] ?? 'another device')
      if (detail?.field === 'device_identifier') return setErrors({ identifier: detail.reason === 'already_exists' ? 'This id is already another provider’s device, or a device with its own token.' : err.message })
      if (detail?.field === 'vehicle_id') return setErrors({ vehicle: detail.reason === 'vehicle_retired' ? 'That vehicle has been retired.' : 'That vehicle is not one you can manage.' })
      if (detail?.field === 'provider_id') return setErrors({ provider: 'That provider cannot have devices.' })
      setErrors({ form: `The device could not be linked (${err.code}).` })
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void submit(false)
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Link device"
      description="Tie a tracker’s id to the vehicle it is installed in. Its provider’s positions then become that vehicle’s."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="link-device" loading={link.isPending && !occupied}>
            Link device
          </Button>
        </>
      }
    >
      <form id="link-device" noValidate onSubmit={onSubmit} className="space-y-1">
        <SelectField
          label="Provider"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          placeholder="Choose a provider"
          options={providers.map((p) => ({ value: p.id, label: p.is_active ? p.name : `${p.name} (switched off)` }))}
          error={errors.provider}
        />
        <TextField
          label="Device id"
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value)
            setOccupied(null)
          }}
          error={errors.identifier}
          hint="Exactly as the provider names it in its webhooks."
          autoComplete="off"
          spellCheck={false}
        />
        <Combobox
          label="Vehicle"
          value={vehicle}
          onChange={(option) => {
            setVehicle(option)
            setOccupied(null)
          }}
          query={vehicleQuery}
          onQueryChange={setVehicleQuery}
          options={vehicleOptions}
          loading={searched.isFetching}
          error={errors.vehicle}
          hint="Type a plate, make or model."
          emptyText={vehicleQuery.trim() ? 'No vehicle matches' : 'Type to search'}
        />
        <TextField label="Model" optional value={model} onChange={(e) => setModel(e.target.value)} hint="e.g. Teltonika FMB920" />

        {occupied && (
          <div role="alert" className="mt-3 space-y-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                {vehicle?.label} already has device <strong className="font-semibold">{occupied}</strong>. Replacing it takes {occupied} out of service; its positions are
                refused from then on.
              </span>
            </p>
            <Button variant="secondary" size="sm" loading={link.isPending} onClick={() => void submit(true)}>
              Replace {occupied}
            </Button>
          </div>
        )}
        {errors.form && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {errors.form}
          </p>
        )}
      </form>
    </Drawer>
  )
}
