import type { PoolClient } from 'pg';
import { depotScope } from '../../../shared/authz/scope';
import type { DomainEvent } from '../../../shared/events/domain-event';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { JobContext } from '../../../shared/jobs/job';
import {
  ENGINE_HOURS_CATCH_UP_DAYS,
  IGNITION_MAX_GAP_SECONDS,
  METER_SYNC_DAYS,
  ONE_READING_PER_REF,
  TELEMATICS_SAMPLE_MINUTES,
  isSuspect,
  type MeterReadingView,
  type NewReading,
  type RecordOutcome,
} from '../domain/meter';
import { vehicleNotFound } from '../domain/vehicle';
import type { MeterListFilter, MeterRepository } from '../infrastructure/meter.repository';
import type { VehicleRepository } from '../infrastructure/vehicle.repository';
import type { Caller } from './caller';

/** An odometer reading another module holds: the vehicle (internal id), the record's public id, the value and when it was true. */
export interface SourceReading {
  vehicleId: string;
  ref: string;
  odometerKm: number;
  at: Date;
}

/**
 * What meter readings are made from, in other modules (connected by src/modules/index.ts: fuel,
 * maintenance and integration import fleet). `since` null means all.
 */
export interface MeterSources {
  /** Fuel logs recorded at or after `since`. */
  fuelLogs(db: Queryable, since: Date | null): Promise<SourceReading[]>;
  /** Completed repairs with an odometer, completed at or after `since`. */
  repairs(db: Queryable, since: Date | null): Promise<SourceReading[]>;
  /**
   * Seconds with the ignition on in [start, end) per vehicle, for the vehicles whose device or telematics
   * pings in that window said whether the ignition was on (0 for one that was off all day). A gap between
   * two pings longer than `maxGapSeconds` adds nothing.
   */
  ignitionSeconds(db: Queryable, start: Date, end: Date, maxGapSeconds: number): Promise<Map<string, number>>;
}

export interface MeterServiceDeps {
  meters: MeterRepository;
  vehicles: Pick<VehicleRepository, 'lockById' | 'update' | 'findRef'>;
  sources: () => MeterSources | null;
  /** Drops a vehicle's cached view (by public id) once its odometer moved. */
  invalidate: (vehiclePublicId: string) => Promise<void>;
}

/** Addis Ababa keeps UTC+3 all year: a local day starts at 00:00+03:00. */
const ADDIS_OFFSET = '+03:00';
const dayStart = (day: string) => new Date(`${day}T00:00:00${ADDIS_OFFSET}`);
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const tenths = (n: number) => Math.round(n * 10) / 10;

/**
 * Odometer and engine-hour readings (FMS-126, docs/meter-readings.md). Each reading is kept with its
 * source. A reading lower than a trusted earlier one is kept as suspect; a trusted odometer reading above
 * the vehicle's odometer moves it up.
 */
export class MeterService {
  constructor(private readonly deps: MeterServiceDeps) {}

  /**
   * Records one reading on the caller's transaction, after row-locking the vehicle (two readings for it
   * are decided one after the other). A fuel log, repair or day already read is a duplicate. Returns what it did,
   * and the vehicle's public id when its odometer moved, to drop its cached view after commit.
   */
  async record(client: PoolClient, ctx: MutationContext, reading: NewReading): Promise<{ outcome: RecordOutcome; moved: boolean }> {
    const { meters, vehicles } = this.deps;
    const vehicle = await vehicles.lockById(client, reading.vehicleId);
    if (!vehicle) return { outcome: 'duplicate', moved: false };
    const once = reading.sourceRef !== null && ONE_READING_PER_REF.includes(reading.source);
    if (once && (await meters.exists(client, reading.vehicleId, reading.meter, reading.source, reading.sourceRef!))) {
      return { outcome: 'duplicate', moved: false };
    }
    const value = tenths(reading.value);
    const highest = await meters.highestTrusted(client, reading.vehicleId, reading.meter, reading.recordedAt);
    const suspect = isSuspect(reading.meter, value, highest);
    await meters.insert(client, ctx, { ...reading, value }, suspect);
    const moved = reading.meter === 'odometer' && !suspect && value > vehicle.odometerKm;
    if (moved) await vehicles.update(ctx, reading.vehicleId, { odometer_km: value }, client);
    return { outcome: suspect ? 'suspect' : 'recorded', moved };
  }

  /** A person set the odometer (registering or editing a vehicle): the vehicle service has written it already. */
  async manual(client: PoolClient, ctx: MutationContext, vehicleId: string, odometerKm: number, at: Date): Promise<void> {
    await this.record(client, ctx, { vehicleId, meter: 'odometer', value: odometerKm, source: 'manual', sourceRef: null, recordedAt: at });
  }

  /**
   * A device's or telematics provider's odometer, from GPS ingestion (FMS-88), on its transaction: kept
   * when the vehicle's newest telematics reading is TELEMATICS_SAMPLE_MINUTES older, else sampled out.
   */
  async telematicsOdometer(client: PoolClient, ctx: MutationContext, vehicleId: string, odometerKm: number, at: Date, deviceRef: string | null): Promise<RecordOutcome> {
    const latest = await this.deps.meters.latestAt(client, vehicleId, 'odometer', 'telematics');
    if (latest && at.getTime() - latest.getTime() < TELEMATICS_SAMPLE_MINUTES * 60_000) return 'sampled_out';
    const { outcome, moved } = await this.record(client, ctx, { vehicleId, meter: 'odometer', value: odometerKm, source: 'telematics', sourceRef: deviceRef, recordedAt: at });
    if (moved) await this.invalidateById(client, vehicleId);
    return outcome;
  }

  /** FuelLogged (FMS-39): the fill-up's odometer, when it happened. */
  onFuelLogged(tx: PoolClient, event: DomainEvent): Promise<void> {
    const p = event.payload;
    if (typeof p.fuel_log_id !== 'string' || typeof p.odometer_km !== 'number' || typeof p.recorded_at !== 'string') return Promise.resolve();
    return this.fromEvent(tx, event, 'fuel_log', p.fuel_log_id, p.odometer_km, p.recorded_at);
  }

  /** MaintenanceRecordCompleted (FMS-22): the repair's odometer, if it was entered, when it was completed. */
  onRepairCompleted(tx: PoolClient, event: DomainEvent): Promise<void> {
    const p = event.payload;
    if (typeof p.maintenance_record_id !== 'string' || typeof p.odometer_km !== 'number' || typeof p.completed_at !== 'string') return Promise.resolve();
    return this.fromEvent(tx, event, 'maintenance', p.maintenance_record_id, p.odometer_km, p.completed_at);
  }

  private async fromEvent(tx: PoolClient, event: DomainEvent, source: 'fuel_log' | 'maintenance', ref: string, km: number, at: string): Promise<void> {
    if (typeof event.payload.vehicle_id !== 'string') return;
    const vehicle = await this.deps.vehicles.findRef(tx, { publicId: event.payload.vehicle_id }, { kind: 'all' });
    if (!vehicle) return;
    const ctx = { userId: null, correlationId: event.correlation_id };
    const { moved } = await this.record(tx, ctx, { vehicleId: vehicle.id, meter: 'odometer', value: km, source, sourceRef: ref, recordedAt: new Date(at) });
    if (moved) await this.deps.invalidate(vehicle.publicId);
  }

  /**
   * Re-adds the fuel-log and repair readings that are missing (an event missed, data written without
   * events: the seed, a restore), oldest first, so each is checked against the readings before it.
   * `since` null: everything.
   */
  async sync(ctx: MutationContext, since: Date | null): Promise<{ added: number }> {
    const sources = this.deps.sources();
    if (!sources) return { added: 0 };
    const { meters } = this.deps;
    return meters.inTransaction(async (client) => {
      const missing: (SourceReading & { source: 'fuel_log' | 'maintenance' })[] = [];
      for (const [source, read] of [
        ['fuel_log', sources.fuelLogs],
        ['maintenance', sources.repairs],
      ] as const) {
        const found = await read(client, since);
        const have = await meters.existingRefs(client, source, found.map((r) => r.ref));
        missing.push(...found.filter((r) => !have.has(r.ref)).map((r) => ({ ...r, source })));
      }
      missing.sort((a, b) => a.at.getTime() - b.at.getTime() || a.ref.localeCompare(b.ref));
      const moved = new Set<string>();
      for (const r of missing) {
        const done = await this.record(client, ctx, { vehicleId: r.vehicleId, meter: 'odometer', value: r.odometerKm, source: r.source, sourceRef: r.ref, recordedAt: r.at });
        if (done.moved) moved.add(r.vehicleId);
      }
      for (const id of moved) await this.invalidateById(client, id);
      return { added: missing.length };
    });
  }

  /** The daily sync job: the last METER_SYNC_DAYS. */
  syncRecent(context: JobContext): Promise<{ added: number }> {
    const since = new Date(context.now.getTime() - METER_SYNC_DAYS * 86_400_000);
    return this.sync({ userId: null, correlationId: context.correlationId }, since);
  }

  /**
   * The nightly engine-hours job: for each local day before today (the run's day), back to
   * ENGINE_HOURS_CATCH_UP_DAYS, each vehicle whose devices reported the ignition that day gets a reading at
   * the day's end: its last engine hours plus the day's ignition-on time. A day already read is skipped,
   * so a re-run, or a run after a missed one, adds only what is missing. Phone-only vehicles get none:
   * phones cannot tell whether the engine runs.
   */
  async recordEngineHours(context: JobContext): Promise<{ days: number; readings: number }> {
    const sources = this.deps.sources();
    if (!sources) return { days: 0, readings: 0 };
    const { meters } = this.deps;
    const ctx = { userId: null, correlationId: context.correlationId };
    let readings = 0;
    for (let back = ENGINE_HOURS_CATCH_UP_DAYS; back >= 1; back--) {
      const day = addDays(context.runKey, -back);
      const [start, end] = [dayStart(day), dayStart(addDays(day, 1))];
      readings += await meters.inTransaction(async (client) => {
        const seconds = await sources.ignitionSeconds(client, start, end, IGNITION_MAX_GAP_SECONDS);
        const done = await meters.engineHoursDone(client, day);
        const todo = [...seconds.keys()].filter((id) => !done.has(id)).sort((a, b) => Number(a) - Number(b));
        const before = await meters.engineHoursBefore(client, todo, end);
        for (const vehicleId of todo) {
          const value = (before.get(vehicleId) ?? 0) + seconds.get(vehicleId)! / 3600;
          await this.record(client, ctx, { vehicleId, meter: 'engine_hours', value, source: 'gps_derived', sourceRef: day, recordedAt: end });
        }
        return todo.length;
      });
    }
    return { days: ENGINE_HOURS_CATCH_UP_DAYS, readings };
  }

  /** GET /vehicles/{vehicle_id}/meter-readings: a vehicle in the caller's scope (404 otherwise), newest first. */
  async list(caller: Caller, vehiclePublicId: string, filter: MeterListFilter): Promise<{ items: MeterReadingView[]; total: number }> {
    const { meters, vehicles } = this.deps;
    return meters.inTransaction(async (client) => {
      const vehicle = await vehicles.findRef(client, { publicId: vehiclePublicId }, depotScope(caller.user));
      if (!vehicle) throw vehicleNotFound();
      return meters.list(client, vehicle.id, filter);
    });
  }

  private async invalidateById(db: Queryable, vehicleId: string): Promise<void> {
    const ref = await this.deps.vehicles.findRef(db, { id: vehicleId }, { kind: 'all' });
    if (ref) await this.deps.invalidate(ref.publicId);
  }
}
