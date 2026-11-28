// Meter readings (FMS-126, docs/meter-readings.md): each vehicle's odometer and engine hours over time,
// with where each reading came from.

/** Enum values exactly as stored (fleet.meter_type, fleet.meter_source). */
export const METERS = ['odometer', 'engine_hours'] as const;
export const METER_SOURCES = ['fuel_log', 'maintenance', 'telematics', 'gps_derived', 'manual', 'trip'] as const;

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

/**
 * The sources whose reading names one source record (a fuel log, a repair, a day, a trip's start or end): at most one
 * reading each.
 */
export const ONE_READING_PER_REF: readonly MeterSource[] = ['fuel_log', 'maintenance', 'gps_derived', 'trip'];

/**
 * FMS-165: the odometer a trip leaves, from TripCompleted. The end reading the driver typed; else, for a trip measured
 * by its GPS track, the start reading plus that distance (an estimate: a track sampled between points cuts corners, so
 * it stays at or below the real odometer and never blocks a later typed reading); else none, as for a trip the
 * vehicle's own device measured, whose readings arrive from telematics.
 */
export function tripEndReading(p: {
  start_odometer_km: number | null;
  end_odometer_km: number | null;
  actual_distance_km: number | null;
  actual_distance_source: 'odometer' | 'gps' | null;
}): { km: number; source: 'trip' | 'gps_derived' } | null {
  if (p.end_odometer_km !== null) return { km: p.end_odometer_km, source: 'trip' };
  if (p.actual_distance_source === 'gps' && p.actual_distance_km !== null && p.start_odometer_km !== null) {
    return { km: Math.floor((p.start_odometer_km + p.actual_distance_km) * 10) / 10, source: 'gps_derived' };
  }
  return null;
}

/** What recording a reading did. */
export type RecordOutcome = 'recorded' | 'suspect' | 'duplicate' | 'sampled_out';

/**
 * Whether an odometer reading is suspect: lower than the highest trusted reading recorded at or before it.
 * Engine hours come from the nightly job only and always add up, so they are never suspect.
 */
export function isSuspect(meter: Meter, value: number, highestBefore: number | null): boolean {
  return meter === 'odometer' && highestBefore !== null && value < highestBefore;
}
