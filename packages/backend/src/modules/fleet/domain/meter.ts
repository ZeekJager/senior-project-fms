// Meter readings (FMS-126, docs/meter-readings.md): each vehicle's odometer and engine hours over time,
// with where each reading came from.

/** Enum values exactly as stored (fleet.meter_type, fleet.meter_source). */
export const METERS = ['odometer', 'engine_hours'] as const;
export const METER_SOURCES = ['fuel_log', 'maintenance', 'telematics', 'gps_derived', 'manual'] as const;

export type Meter = (typeof METERS)[number];
export type MeterSource = (typeof METER_SOURCES)[number];

/** A device's odometer is recorded at most this often per vehicle: the history needs the trend, not every ping. */
export const TELEMATICS_SAMPLE_MINUTES = 60;
/**
 * Two pings further apart than this say nothing about the time between them (the device was off or had no
 * signal), so that gap adds no engine time even when the earlier ping had the ignition on.
 */
export const IGNITION_MAX_GAP_SECONDS = 600;
/** The engine-hours job fills in days it missed, back this many days (the server was down). */
export const ENGINE_HOURS_CATCH_UP_DAYS = 7;
/** The daily sync re-adds fuel-log and repair readings recorded in this many past days whose event was missed. */
export const METER_SYNC_DAYS = 30;

/** A reading as the API returns it (api-contract §6.2, `MeterReading`). */
export interface MeterReadingView {
  id: string;
  meter: Meter;
  /** km for the odometer, hours for engine hours. */
  value: number;
  source: MeterSource;
  /** The fuel log's or repair's id, the device's id, or the day (YYYY-MM-DD) of an engine-hours reading. */
  source_ref: string | null;
  recorded_at: Date;
  /** Lower than a trusted reading recorded before it: kept, but the vehicle's odometer did not follow it. */
  suspect: boolean;
  created_at: Date;
}

/** One reading to record. `vehicleId` is internal. */
export interface NewReading {
  vehicleId: string;
  meter: Meter;
  value: number;
  source: MeterSource;
  sourceRef: string | null;
  recordedAt: Date;
}

/** The sources whose reading names one source record (a fuel log, a repair, a day): at most one reading each. */
export const ONE_READING_PER_REF: readonly MeterSource[] = ['fuel_log', 'maintenance', 'gps_derived'];

/** What recording a reading did. */
export type RecordOutcome = 'recorded' | 'suspect' | 'duplicate' | 'sampled_out';

/**
 * Whether an odometer reading is suspect: lower than the highest trusted reading recorded at or before it.
 * Engine hours come from the nightly job only and always add up, so they are never suspect.
 */
export function isSuspect(meter: Meter, value: number, highestBefore: number | null): boolean {
  return meter === 'odometer' && highestBefore !== null && value < highestBefore;
}
