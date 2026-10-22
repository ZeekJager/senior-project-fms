// A fill-up as the driver enters it (FMS-40, S-14), and as POST /fuel-logs
// takes it (api-contract §9.1): whole millilitres and cents, never a float.
// The inputs already give integers (FuelInput: "23.5" -> 23500 ml), so
// nothing here multiplies or rounds an amount that is sent.

/** POST /fuel-logs bounds: what the form checks before anything is queued. */
export const MAX_QUANTITY_ML = 2_000_000
export const MAX_COST_CENTS = 100_000_000
/** NUMERIC(12,1): 99,999,999,999.9 km, in tenths. */
export const MAX_ODOMETER_TENTHS = 999_999_999_999

export interface FillUp {
  /** Integer millilitres. */
  quantityMl: number | null
  /** Integer cents. */
  totalCents: number | null
  /** Integer tenths of a km (OdometerInput). */
  odometerTenths: number | null
  station: string
}

export type FillUpErrors = Partial<Record<'quantity' | 'total' | 'odometer' | 'station', string>>

export function checkFillUp(f: FillUp): FillUpErrors {
  const errors: FillUpErrors = {}
  if (f.quantityMl === null) errors.quantity = 'Enter the litres you put in.'
  else if (f.quantityMl < 1) errors.quantity = 'Enter more than 0 litres.'
  else if (f.quantityMl > MAX_QUANTITY_ML) errors.quantity = 'That is more than any tank holds (2,000 L at most).'
  if (f.totalCents === null) errors.total = 'Enter what you paid, from the receipt.'
  else if (f.totalCents > MAX_COST_CENTS) errors.total = 'That amount is too large.'
  if (f.odometerTenths === null) errors.odometer = 'Enter the odometer reading.'
  else if (f.odometerTenths > MAX_ODOMETER_TENTHS) errors.odometer = 'That reading is too large.'
  if (f.station.trim().length > 255) errors.station = 'Use at most 255 characters.'
  return errors
}

/**
 * The body, once `checkFillUp` found nothing. `odometer_km` keeps its one decimal: 1234567 tenths is 123456.7.
 * `fueled_at` is the moment the driver pressed submit (FMS-115): a fill-up queued in a dead zone keeps its pump
 * time however late the queue delivers it.
 */
export function fuelLogBody(f: FillUp, vehicleId: string, tripId: string, now: Date) {
  const station = f.station.trim()
  return {
    vehicle_id: vehicleId,
    trip_id: tripId,
    quantity_ml: f.quantityMl!,
    total_cost_cents: f.totalCents!,
    odometer_km: f.odometerTenths! / 10,
    ...(station ? { station_name: station } : {}),
    fueled_at: now.toISOString(),
  }
}

/** Price per litre for the hint, in cents, rounded: shown only, never sent. */
export const centsPerLitre = (totalCents: number, quantityMl: number) => Math.round((totalCents * 1000) / quantityMl)
