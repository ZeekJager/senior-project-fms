import { notFound } from '../../../shared/errors/app-error';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import type { AccountExport } from '../../auth';
import type { DriverIncidentExport } from '../../alert';
import type { DriverFuelLogExport } from '../../fuel';
import type { DriverTripExport } from '../../trip';

/** The most location points one export carries: the newest, with `truncated` set when there were more. */
export const EXPORT_PING_CAP = 50_000;

type Json = Record<string, unknown>;

/** The API's field names are snake_case (api-contract §3): `fuelType` becomes `fuel_type`. Top-level keys only; JSON values are left as stored. */
/** A record without some keys. */
const omit = <T extends object>(record: T, keys: readonly (keyof T)[]): Partial<T> => Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k as keyof T))) as Partial<T>;

const snake = (record: object): Json => Object.fromEntries(Object.entries(record).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));

/** What the export needs from the modules that hold a person's records (wired in privacy/index.ts). */
export interface DataExportRefs {
  account(db: Queryable, userId: string): Promise<AccountExport | null>;
  driver(db: Queryable, userId: string): Promise<{ driverId: string; driver: Json; assignments: Json[]; attendance: Json[]; dvirReports: Json[] } | null>;
  trips(db: Queryable, driverId: string): Promise<DriverTripExport[]>;
  fuelLogs(db: Queryable, driverId: string): Promise<DriverFuelLogExport[]>;
  incidents(db: Queryable, driverId: string | null, userId: string): Promise<DriverIncidentExport[]>;
  pings(db: Queryable, tripIds: readonly string[], limit: number): Promise<{ tripId: string; recordedAt: string; latitude: number; longitude: number; speedKmh: number }[]>;
  vehicles(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; registrationNumber: string }>>;
  tripIds(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string }>>;
}

export interface DataExportDeps {
  db: Queryable;
  refs: DataExportRefs;
  /** Days of GPS history kept (config.tracking.retention.pingDays): stated in the export, so a person knows how far it reaches. */
  pingRetentionDays: number;
  now?: () => Date;
}

/**
 * A person's own data (FMS-104, docs/driver-data-protection.md): the account, and for a driver the licence and fleet
 * records, trips, fuel logs, incident reports and where their trips' vehicles were. Only the caller's own: there is no
 * id to give. Internal ids never leave: vehicles and trips appear by public id (and the vehicle by plate). Every export
 * is audited, with counts only.
 */
export class DataExportService {
  constructor(private readonly deps: DataExportDeps) {}

  async forUser(user: RequestUser, correlationId: string): Promise<Json> {
    const { db, refs } = this.deps;
    const userId = user.id!;
    const account = await refs.account(db, userId);
    if (!account) throw notFound('Account not found.');

    const fleet = await refs.driver(db, userId);
    const trips = fleet ? await refs.trips(db, fleet.driverId) : [];
    const fuelLogs = fleet ? await refs.fuelLogs(db, fleet.driverId) : [];
    const incidents = await refs.incidents(db, fleet?.driverId ?? null, userId);
    const tripInternalIds = trips.map((t) => t.internalId);
    const pings = await refs.pings(db, tripInternalIds, EXPORT_PING_CAP);
    const truncated = pings.length > EXPORT_PING_CAP;
    const points = truncated ? pings.slice(pings.length - EXPORT_PING_CAP) : pings;

    // Internal ids to public ones, in one lookup each.
    const vehicleIds = [
      ...new Set([
        ...trips.flatMap((t) => (t.vehicleId ? [t.vehicleId] : [])),
        ...fuelLogs.map((f) => f.vehicleId),
        ...incidents.flatMap((i) => (i.vehicleId ? [i.vehicleId] : [])),
        ...(fleet?.assignments ?? []).map((a) => String(a.vehicleId)),
        ...(fleet?.dvirReports ?? []).map((d) => String(d.vehicleId)),
      ]),
    ];
    const otherTripIds = [
      ...new Set([
        ...fuelLogs.flatMap((f) => (f.tripId ? [f.tripId] : [])),
        ...incidents.flatMap((i) => (i.tripId ? [i.tripId] : [])),
        ...(fleet?.dvirReports ?? []).flatMap((d) => (d.tripId ? [String(d.tripId)] : [])),
        ...points.map((p) => p.tripId),
      ]),
    ];
    const vehicles = await refs.vehicles(db, vehicleIds);
    const tripPublic = await refs.tripIds(db, otherTripIds);
    const vehicle = (id: unknown) => {
      const v = id === null || id === undefined ? undefined : vehicles.get(String(id));
      return v ? { vehicle_id: v.publicId, vehicle_registration: v.registrationNumber } : { vehicle_id: null, vehicle_registration: null };
    };
    const trip = (id: unknown) => (id === null || id === undefined ? null : (tripPublic.get(String(id))?.publicId ?? null));

    const data = {
      generated_at: (this.deps.now ?? (() => new Date()))().toISOString(),
      account,
      driver: fleet
        ? {
            ...fleet.driver,
            vehicle_assignments: fleet.assignments.map(({ vehicleId, ...a }) => ({ ...snake(a), ...vehicle(vehicleId) })),
            attendance: fleet.attendance,
            inspections: fleet.dvirReports.map(({ vehicleId, tripId, ...d }) => ({ ...snake(d), ...vehicle(vehicleId), trip_id: trip(tripId) })),
          }
        : null,
      trips: trips.map((t) => ({ ...snake(omit(t, ['internalId', 'vehicleId'])), ...vehicle(t.vehicleId) })),
      fuel_logs: fuelLogs.map(({ vehicleId, tripId, ...f }) => ({ ...snake(f), ...vehicle(vehicleId), trip_id: trip(tripId) })),
      incident_reports: incidents.map(({ vehicleId, tripId, ...i }) => ({ ...snake(i), ...vehicle(vehicleId), trip_id: trip(tripId) })),
      location_history: {
        retention_days: this.deps.pingRetentionDays,
        truncated,
        points: points.map((p) => ({ trip_id: trip(p.tripId), recorded_at: p.recordedAt, lat: p.latitude, lng: p.longitude, speed_kmh: p.speedKmh })),
      },
    };

    // Who took a copy of what the system holds about them, and when; counts, never the data.
    await recordAuditEntry(db, {
      action: 'privacy.data_exported',
      userId,
      entityType: 'auth.users',
      entityId: userId,
      correlationId,
      details: {
        driver: fleet !== null,
        trips: data.trips.length,
        fuel_logs: data.fuel_logs.length,
        incident_reports: data.incident_reports.length,
        location_points: data.location_history.points.length,
        truncated,
      },
    });
    return data;
  }
}
