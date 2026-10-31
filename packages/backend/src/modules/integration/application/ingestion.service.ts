import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { validationFailed } from '../../../shared/errors/app-error';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestSource } from '../../../shared/infrastructure/request-source';
import type { RequestUser } from '../../../types/express';
import {
  MAX_FUTURE_SKEW_MS,
  MAX_PING_AGE_MS,
  TRACKING_EVENTS,
  notYourTrip,
  notYourVehicle,
  phoneNotOnTrip,
  pingProblem,
  roundSpeed,
  tripAt,
  type PingInput,
  type PingRejection,
  type PingSource,
} from '../domain/gps';
import type { DeviceRepository, DeviceRow } from '../infrastructure/device.repository';
import type { PingRow, TrackingRepository } from '../infrastructure/tracking.repository';

/** A vehicle as ingestion needs it, from the fleet module. */
export interface IngestVehicle {
  id: string;
  publicId: string;
  depotPublicId: string | null;
  isActive: boolean;
}

export interface EnRouteTrip {
  id: string;
  publicId: string;
  vehicleId: string | null;
}

/** A trip that has started, with when it was driven: what a ping recorded in it is placed by (FMS-124). */
export interface IngestTripSpan {
  id: string;
  publicId: string;
  vehicleId: string | null;
  actualStart: Date;
  /** Null while the trip is under way. */
  actualEnd: Date | null;
  /** The trip has finished since (it is completed now). */
  ended: boolean;
}

/** What ingestion needs from fleet and trip (connected in integration/index.ts). */
export interface IngestionRefs {
  vehicles: {
    byPublicIds(db: Queryable, publicIds: readonly string[], scope: Scope): Promise<IngestVehicle[]>;
    byIds(db: Queryable, ids: readonly string[]): Promise<IngestVehicle[]>;
  };
  drivers: { idOfUser(db: Queryable, userId: string): Promise<string | null> };
  trips: {
    /** The legacy socket event's trip: the driver's trip under way now. */
    enRouteOfDriver(db: Queryable, driverId: string): Promise<EnRouteTrip | null>;
    /** The trips driven in [from, to]: by a driver (internal id), or on these vehicles. */
    spansOfDriver(db: Queryable, driverId: string, from: Date, to: Date): Promise<IngestTripSpan[]>;
    spansOfVehicles(db: Queryable, vehicleIds: readonly string[], from: Date, to: Date): Promise<IngestTripSpan[]>;
  };
  /** A device's odometer becomes a meter reading (FMS-126); fleet samples it. */
  meters: {
    telematicsOdometer(client: PoolClient, ctx: MutationContext, vehicleId: string, odometerKm: number, at: Date, deviceRef: string | null): Promise<unknown>;
  };
}

/**
 * Who sends a batch, which decides the vehicles it may report for (security, FMS-88):
 * - a device (its token): its own vehicle only;
 * - a signed-in user with `tracking:ingest`: any vehicle in their scope, named per ping;
 * - a driver's phone (`trip:execute`): the vehicle of their trip under way only;
 * - a telematics provider (a verified webhook): its own devices' vehicles.
 */
export type Reporter =
  | { kind: 'device'; device: DeviceRow }
  | { kind: 'user'; user: RequestUser }
  /** A phone however the user's roles read: the legacy socket event (api-contract §11.2), which names the trip. */
  | { kind: 'phone'; user: RequestUser; tripId: string }
  | { kind: 'provider'; providerId: string; providerCode: string };

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: { index: number; reason: PingRejection }[];
}

export interface IngestionServiceDeps {
  tracking: TrackingRepository;
  devices: DeviceRepository;
  refs: IngestionRefs;
  events: EventBus;
  /** VehicleLocationUpdated at most once per vehicle per this many seconds of its own clock. */
  eventIntervalSeconds: number;
  now?: () => number;
}

/** A device token: a prefix that says what it is, then 32 random bytes. Only its SHA-256 is stored. */
const TOKEN_PREFIX = 'fmsd_';
export const hashDeviceToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Where each ping goes: the vehicle (internal id), the device that sent it (both ids) and, when the reporter
 * already knows it (a driver's phone), the trip it was recorded in; or why it was refused. `trip` left out means
 * "not looked up yet": ingestion finds it from the ping's time (FMS-124).
 */
type Placement = { vehicle: IngestVehicle; deviceId: string | null; devicePublicId?: string; trip?: IngestTripSpan } | { reason: PingRejection };

/**
 * GPS ingestion (FMS-88): one path for devices, phones, users and telematics webhooks into
 * tracking.gps_pings. A batch is checked whole for who may report what (403, nothing stored), then ping by
 * ping for what can be used (refused pings are listed, the rest stored). Duplicates are skipped by the
 * database. Each vehicle's newest stored ping may be announced as VehicleLocationUpdated, throttled per vehicle.
 */
export class IngestionService {
  private readonly now: () => number;

  constructor(private readonly deps: IngestionServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** On `tx` when given (the webhook consumer's), else in a transaction of its own. */
  ingest(reporter: Reporter, pings: readonly PingInput[], correlationId: string, tx?: PoolClient): Promise<IngestResult> {
    const run = (client: PoolClient) => this.ingestIn(client, reporter, pings, correlationId);
    return tx ? run(tx) : this.deps.devices.inTransaction(run);
  }

  /** The active device holding this token, or null. */
  async authenticateDevice(token: string): Promise<DeviceRow | null> {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const { devices } = this.deps;
    return devices.findByTokenHash(devices.pool(), hashDeviceToken(token));
  }

  /**
   * Installs a device in a vehicle and returns its token, shown once (scripts/gps-device.ts, the simulator).
   * The same identifier again gets a new token (the old one stops working). A vehicle has one active device:
   * another one there is taken out of service.
   */
  async registerDevice(input: { vehicleId: string; identifier: string; providerId?: string | null; model?: string | null }, ctx: MutationContext): Promise<{ deviceId: string; token: string }> {
    const { devices, refs } = this.deps;
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const tokenHash = hashDeviceToken(token);
    return devices.inTransaction(async (client) => {
      const [vehicle] = await refs.vehicles.byPublicIds(client, [input.vehicleId], { kind: 'all' });
      if (!vehicle) throw validationFailed([{ field: 'vehicle_id', reason: 'references_missing_record' }], 'No such vehicle.');
      if (!vehicle.isActive) throw validationFailed([{ field: 'vehicle_id', reason: 'vehicle_retired' }], 'The vehicle has been retired.');
      const existing = await devices.findByIdentifier(client, input.identifier);
      const occupant = await devices.activeForVehicle(client, vehicle.id);
      if (occupant && occupant.id !== existing?.id) await devices.remove(ctx, occupant.id, client);
      if (existing) {
        await devices.reissue(ctx, existing.id, vehicle.id, tokenHash, client);
        return { deviceId: existing.publicId, token };
      }
      const row = await devices.insert(
        ctx,
        { vehicle_id: vehicle.id, provider_id: input.providerId ?? null, device_identifier: input.identifier, device_model: input.model ?? null, token_hash: tokenHash },
        client,
      );
      return { deviceId: row.public_id as string, token };
    });
  }

  private async ingestIn(client: PoolClient, reporter: Reporter, pings: readonly PingInput[], correlationId: string): Promise<IngestResult> {
    const now = this.now();
    const { placements, source } = await this.place(client, reporter, pings);

    const rejected: IngestResult['rejected'] = [];
    const rows: PingRow[] = [];
    // The trip each row was recorded in (FMS-124); undefined until looked up from the ping's time.
    const spans: (IngestTripSpan | null | undefined)[] = [];
    const vehicles = new Map<string, IngestVehicle>();
    // Each vehicle's newest odometer from its own device or telematics provider (phones and users are not meters).
    const odometers = new Map<string, { km: number; at: Date; deviceRef: string | null }>();
    pings.forEach((ping, index) => {
      const placed = placements[index];
      if ('reason' in placed) {
        // A time outside any trip is the reason, unless the ping is unusable for a plainer one (too old, in the future).
        rejected.push({ index, reason: placed.reason === 'no_trip_at_time' ? (pingProblem(ping, now) ?? placed.reason) : placed.reason });
        return;
      }
      const reason = placed.vehicle.isActive ? pingProblem(ping, now) : 'vehicle_retired';
      if (reason) {
        rejected.push({ index, reason });
        return;
      }
      vehicles.set(placed.vehicle.id, placed.vehicle);
      if (ping.odometer_km != null && (source === 'device' || source === 'telematics')) {
        const at = new Date(ping.recorded_at);
        const seen = odometers.get(placed.vehicle.id);
        if (!seen || at > seen.at) odometers.set(placed.vehicle.id, { km: ping.odometer_km, at, deviceRef: placed.devicePublicId ?? null });
      }
      spans.push(placed.trip);
      rows.push({
        vehicleId: placed.vehicle.id,
        tripId: placed.trip?.id ?? null,
        deviceId: placed.deviceId,
        lat: ping.lat,
        lng: ping.lng,
        speedKmh: roundSpeed(ping.speed_kmh),
        heading: ping.heading ?? null,
        altitudeM: ping.altitude_m ?? null,
        accuracyM: ping.accuracy_m ?? null,
        ignitionOn: ping.ignition_on ?? null,
        odometerKm: ping.odometer_km ?? null,
        source,
        recordedAt: ping.recorded_at,
      });
    });

    await this.placeInTrips(client, rows, spans);

    // A ping of a trip that has ended is history: stored with its trip, never the vehicle's position (FMS-124).
    const live: PingRow[] = [];
    const history: PingRow[] = [];
    rows.forEach((row, i) => (spans[i]?.ended ? history : live).push(row));
    const insertedLive = await this.deps.tracking.insertPings(client, live);
    const insertedHistory = await this.deps.tracking.insertPings(client, history, { historyOnly: true });
    const inserted = [...insertedLive, ...insertedHistory];
    const tripOf = new Map(rows.map((row, i) => [`${row.vehicleId}:${Date.parse(row.recordedAt)}`, spans[i]?.publicId ?? null]));
    await this.announce(client, insertedLive, vehicles, (vehicleId, at) => tripOf.get(`${vehicleId}:${at.getTime()}`) ?? null, reporter, correlationId);
    for (const [vehicleId, { km, at, deviceRef }] of odometers) {
      await this.deps.refs.meters.telematicsOdometer(client, { userId: null, correlationId }, vehicleId, km, at, deviceRef);
    }

    const deviceIds = [...new Set(rows.flatMap((r) => (r.deviceId ? [r.deviceId] : [])))];
    await this.deps.devices.touch(client, deviceIds, new Date(now));

    const result: IngestResult = { accepted: inserted.length, duplicates: rows.length - inserted.length, rejected };
    await recordAuditEntry(client, {
      action: 'tracking.pings_ingested',
      userId: reporter.kind === 'user' || reporter.kind === 'phone' ? reporter.user.id : null,
      entityType: 'tracking.gps_pings',
      entityId: null,
      correlationId,
      source: reporter.kind === 'provider' ? ({ channel: 'webhook' } satisfies RequestSource) : undefined,
      details: {
        source,
        ...(reporter.kind === 'device' ? { device_id: reporter.device.publicId } : {}),
        ...(reporter.kind === 'provider' ? { provider: reporter.providerCode } : {}),
        received: pings.length,
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: rejected.length,
        vehicles: vehicles.size,
      },
    });
    return result;
  }

  /** Where each ping goes, by who reports. Throws 403 for a whole batch that names a vehicle it may not. */
  private async place(client: PoolClient, reporter: Reporter, pings: readonly PingInput[]): Promise<{ placements: Placement[]; source: PingSource }> {
    const { refs, devices } = this.deps;

    if (reporter.kind === 'device') {
      const [vehicle] = await refs.vehicles.byIds(client, [reporter.device.vehicleId]);
      if (pings.some((p) => p.vehicle_id !== undefined && p.vehicle_id !== vehicle.publicId)) throw notYourVehicle();
      return { placements: pings.map(() => ({ vehicle, deviceId: reporter.device.id, devicePublicId: reporter.device.publicId })), source: 'device' };
    }

    if (reporter.kind === 'provider') {
      const found = await devices.providerDevices(client, reporter.providerId, [...new Set(pings.map((p) => p.device_id ?? ''))]);
      const vehicles = new Map((await refs.vehicles.byIds(client, [...new Set([...found.values()].map((d) => d.vehicleId))])).map((v) => [v.id, v]));
      const placements = pings.map((p): Placement => {
        const device = found.get(p.device_id ?? '');
        const vehicle = device && vehicles.get(device.vehicleId);
        return device && vehicle ? { vehicle, deviceId: device.id, devicePublicId: device.publicId } : { reason: 'unknown_device' };
      });
      return { placements, source: 'telematics' };
    }

    const { user } = reporter;
    if (reporter.kind === 'user' && user.permissions.includes('tracking:ingest')) {
      const missing = pings.flatMap((p, i) => (p.vehicle_id ? [] : [{ field: `pings.${i}.vehicle_id`, reason: 'required' }]));
      if (missing.length > 0) throw validationFailed(missing, 'Each ping names its vehicle.');
      const found = new Map((await refs.vehicles.byPublicIds(client, [...new Set(pings.map((p) => p.vehicle_id!))], depotScope(user))).map((v) => [v.publicId, v]));
      const placements = pings.map((p): Placement => {
        const vehicle = found.get(p.vehicle_id!);
        return vehicle ? { vehicle, deviceId: null } : { reason: 'unknown_vehicle' };
      });
      return { placements, source: 'api' };
    }

    // A driver's phone (trip:execute): the vehicles of trips the driver drove, nothing else.
    const driverId = user.id ? await refs.drivers.idOfUser(client, user.id) : null;

    // The legacy socket event sends one position of "now" for the trip it names, which must be the one under way.
    if (reporter.kind === 'phone') {
      const trip = driverId ? await refs.trips.enRouteOfDriver(client, driverId) : null;
      if (!trip?.vehicleId) throw phoneNotOnTrip();
      if (reporter.tripId !== trip.publicId) throw notYourTrip();
      const [vehicle] = await refs.vehicles.byIds(client, [trip.vehicleId]);
      if (pings.some((p) => p.vehicle_id !== undefined && p.vehicle_id !== vehicle.publicId)) throw notYourVehicle();
      const span: IngestTripSpan = { id: trip.id, publicId: trip.publicId, vehicleId: trip.vehicleId, actualStart: new Date(0), actualEnd: null, ended: false };
      return { placements: pings.map(() => ({ vehicle, deviceId: null, trip: span })), source: 'phone' };
    }

    // A buffered batch (FMS-124): each ping belongs to the trip the driver was on when it was recorded, however
    // late the phone delivers it, so a trip that ended before the phone found signal still gets its last stretch.
    // A phone with no trip at all in the 7 days a ping may be old is refused whole; one ping outside every trip
    // (before the trip began, after it ended) is refused alone.
    const now = this.now();
    const spans = driverId ? await refs.trips.spansOfDriver(client, driverId, new Date(now - MAX_PING_AGE_MS), new Date(now + MAX_FUTURE_SKEW_MS)) : [];
    if (spans.length === 0) throw phoneNotOnTrip();
    const vehicles = new Map((await refs.vehicles.byIds(client, [...new Set(spans.flatMap((s) => (s.vehicleId ? [s.vehicleId] : [])))])).map((v) => [v.id, v]));
    const tripOf = (ping: PingInput) => tripAt(spans, Date.parse(ping.recorded_at));
    // Naming a vehicle other than the one of the trip the ping falls in (or, outside every trip, any of the driver's) refuses the batch.
    const own = new Set([...vehicles.values()].map((v) => v.publicId));
    for (const ping of pings) {
      if (ping.vehicle_id === undefined) continue;
      const span = tripOf(ping);
      const expected = span?.vehicleId ? vehicles.get(span.vehicleId)?.publicId : undefined;
      if (span ? ping.vehicle_id !== expected : !own.has(ping.vehicle_id)) throw notYourVehicle();
    }
    const placements = pings.map((ping): Placement => {
      const trip = tripOf(ping);
      const vehicle = trip?.vehicleId ? vehicles.get(trip.vehicleId) : undefined;
      return trip && vehicle ? { vehicle, deviceId: null, trip } : { reason: 'no_trip_at_time' };
    });
    return { placements, source: 'phone' };
  }

  /**
   * The trip each row was recorded in, for the rows whose reporter did not name one (devices, providers, users):
   * the vehicle's trip driven at the ping's time, or none (FMS-124). Fills `spans` and each row's `tripId`.
   */
  private async placeInTrips(client: PoolClient, rows: PingRow[], spans: (IngestTripSpan | null | undefined)[]): Promise<void> {
    const open = rows.map((_, i) => i).filter((i) => spans[i] === undefined);
    if (open.length === 0) return;
    const times = open.map((i) => Date.parse(rows[i].recordedAt));
    const found = await this.deps.refs.trips.spansOfVehicles(client, [...new Set(open.map((i) => rows[i].vehicleId))], new Date(Math.min(...times)), new Date(Math.max(...times)));
    const byVehicle = new Map<string, IngestTripSpan[]>();
    for (const span of found) {
      if (span.vehicleId) byVehicle.set(span.vehicleId, [...(byVehicle.get(span.vehicleId) ?? []), span]);
    }
    for (const i of open) {
      const span = tripAt(byVehicle.get(rows[i].vehicleId) ?? [], Date.parse(rows[i].recordedAt));
      spans[i] = span;
      rows[i].tripId = span?.id ?? null;
    }
  }

  /** VehicleLocationUpdated for each vehicle whose newest stored ping became its position and is due (throttle). */
  private async announce(
    client: PoolClient,
    inserted: readonly { vehicleId: string; recordedAt: Date }[],
    vehicles: Map<string, IngestVehicle>,
    /** The public id of the trip a stored ping was recorded in. */
    tripOf: (vehicleId: string, recordedAt: Date) => string | null,
    reporter: Reporter,
    correlationId: string,
  ): Promise<void> {
    const newest = new Map<string, Date>();
    for (const { vehicleId, recordedAt } of inserted) {
      const seen = newest.get(vehicleId);
      if (!seen || recordedAt > seen) newest.set(vehicleId, recordedAt);
    }
    const due = await this.deps.tracking.claimAnnouncements(
      client,
      [...newest].map(([vehicleId, recordedAt]) => ({ vehicleId, recordedAt })),
      this.deps.eventIntervalSeconds,
    );
    if (due.length === 0) return;
    const actor = reporter.kind === 'user' || reporter.kind === 'phone' ? reporter.user.publicId : null;
    await this.deps.events.publish(
      client,
      due.map((p) => {
        const vehicle = vehicles.get(p.vehicleId)!;
        return createEvent(
          TRACKING_EVENTS.locationUpdated,
          {
            vehicle_id: vehicle.publicId,
            depot_id: vehicle.depotPublicId,
            trip_id: tripOf(p.vehicleId, p.recordedAt),
            lat: p.lat,
            lng: p.lng,
            speed: p.speed,
            heading: p.heading,
            recorded_at: p.recordedAt.toISOString(),
          },
          { actor, correlationId },
          { aggregate: aggregateKey('vehicle', vehicle.publicId) },
        );
      }),
    );
  }
}
