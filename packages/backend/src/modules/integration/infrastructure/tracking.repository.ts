import type { PoolClient } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { PingSource } from '../domain/gps';
import { STOPPED_LOOKBACK_HOURS } from '../domain/live-map';
import type { TrackPointRow, TrackQuery } from '../domain/track-history';
import type { RulePing } from '../domain/telemetry-rules';

/** A ping ready to store: internal ids, integer speed. */
export interface PingRow {
  vehicleId: string;
  tripId: string | null;
  deviceId: string | null;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number | null;
  altitudeM: number | null;
  accuracyM: number | null;
  ignitionOn: boolean | null;
  odometerKm: number | null;
  source: PingSource;
  recordedAt: string;
}

/** A vehicle's current position, as announced in VehicleLocationUpdated. */
export interface AnnouncedPosition {
  vehicleId: string;
  lat: number;
  lng: number;
  speed: number;
  heading: number | null;
  recordedAt: Date;
}

/** A vehicle's current position as the live map reads it (FMS-45). */
export interface LivePosition {
  vehicleId: string;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number | null;
  accuracyM: number | null;
  ignitionOn: boolean | null;
  recordedAt: Date;
  /** At 0 km/h: the first ping of the run of stopped pings that ends at the current one (looked back at most STOPPED_LOOKBACK_HOURS). */
  stoppedSince: Date | null;
}

/** An open telemetry flag (FMS-46 raises them): the newest of each type per vehicle. */
export interface OpenFlag {
  vehicleId: string;
  flagType: string;
  severity: string;
  observedAt: Date;
}

/**
 * tracking.gps_pings and tracking.vehicle_current_location (FMS-88). Pings are not written one by one
 * through `auditedMutation`: a batch is one statement and one audit entry (the service writes it),
 * since an audit row per ping would double the telemetry. The current location follows each insert
 * (trigger, migration 007), only ever forward in time.
 */
export class TrackingRepository {
  /**
   * Inserts the pings in one statement. A ping already stored, the same vehicle at the same instant
   * (a retried batch, a provider redelivering), is skipped: `uq_gps_ping_vehicle_time` (api-contract §15).
   * Returns the pings actually inserted.
   *
   * `historyOnly` stores pings of a trip that has already ended (FMS-124): they join the vehicle's history but
   * never become its current position. It is a transaction-local setting the current-location trigger reads
   * (migration 042), set only around this one INSERT; if the INSERT fails the transaction ends and with it the setting.
   */
  async insertPings(client: PoolClient, rows: readonly PingRow[], options: { historyOnly?: boolean } = {}): Promise<{ vehicleId: string; recordedAt: Date }[]> {
    if (rows.length === 0) return [];
    const col = <K extends keyof PingRow>(key: K) => rows.map((r) => r[key]);
    if (options.historyOnly) await client.query("SELECT set_config('fms.ping_history_only', 'on', true)");
    const res = await client.query<{ vehicleId: string; recordedAt: Date }>(
      `INSERT INTO tracking.gps_pings
              (vehicle_id, trip_id, gps_device_id, latitude, longitude, speed_kmh, heading_degrees, altitude_m,
               accuracy_m, ignition_on, odometer_km, source, recorded_at)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::numeric[], $5::numeric[], $6::smallint[], $7::numeric[],
                            $8::numeric[], $9::numeric[], $10::boolean[], $11::numeric[], $12::varchar[], $13::timestamptz[])
       ON CONFLICT DO NOTHING
       RETURNING vehicle_id AS "vehicleId", recorded_at AS "recordedAt"`,
      [
        col('vehicleId'),
        col('tripId'),
        col('deviceId'),
        col('lat'),
        col('lng'),
        col('speedKmh'),
        col('heading'),
        col('altitudeM'),
        col('accuracyM'),
        col('ignitionOn'),
        col('odometerKm'),
        col('source'),
        col('recordedAt'),
      ],
    );
    if (options.historyOnly) await client.query("SELECT set_config('fms.ping_history_only', 'off', true)");
    return res.rows;
  }

  /**
   * Claims the right to announce each vehicle's newest ping: only when that ping is the vehicle's current
   * position and at least `minIntervalSeconds` newer than the last one announced. The UPDATE checks and
   * records it at once, so concurrent batches (or instances) announce a position once. Returns the
   * positions to announce.
   */
  async claimAnnouncements(client: PoolClient, newest: readonly { vehicleId: string; recordedAt: Date }[], minIntervalSeconds: number): Promise<AnnouncedPosition[]> {
    if (newest.length === 0) return [];
    const res = await client.query<AnnouncedPosition>(
      `UPDATE tracking.vehicle_current_location c
          SET event_recorded_at = n.recorded_at
         FROM unnest($1::bigint[], $2::timestamptz[]) AS n(vehicle_id, recorded_at)
        WHERE c.vehicle_id = n.vehicle_id
          AND c.recorded_at = n.recorded_at
          AND (c.event_recorded_at IS NULL OR n.recorded_at >= c.event_recorded_at + make_interval(secs => $3))
       RETURNING c.vehicle_id AS "vehicleId", c.latitude::float8 AS lat, c.longitude::float8 AS lng, c.speed_kmh AS speed,
                 c.heading_degrees::float8 AS heading, c.recorded_at AS "recordedAt"`,
      [newest.map((n) => n.vehicleId), newest.map((n) => n.recordedAt), minIntervalSeconds],
    );
    return res.rows;
  }

  /**
   * The current position of each vehicle (internal ids) that has one. A stopped vehicle also gets when it
   * stopped: after the last moving ping, within STOPPED_LOOKBACK_HOURS before its current one; so the map shows a vehicle
   * idling for 10 minutes as idling as soon as it opens, not 5 minutes later.
   */
  async livePositions(db: Queryable, vehicleIds: readonly string[]): Promise<LivePosition[]> {
    if (vehicleIds.length === 0) return [];
    const res = await db.query<LivePosition>(
      `SELECT c.vehicle_id AS "vehicleId", c.latitude::float8 AS lat, c.longitude::float8 AS lng, c.speed_kmh AS "speedKmh",
              c.heading_degrees::float8 AS heading, c.accuracy_m::float8 AS "accuracyM", c.ignition_on AS "ignitionOn",
              c.recorded_at AS "recordedAt",
              CASE WHEN c.speed_kmh = 0 THEN (
                SELECT min(p.recorded_at) FROM tracking.gps_pings p
                 WHERE p.vehicle_id = c.vehicle_id AND p.recorded_at <= c.recorded_at
                   AND p.recorded_at > COALESCE(
                         (SELECT max(m.recorded_at) FROM tracking.gps_pings m
                           WHERE m.vehicle_id = c.vehicle_id AND m.speed_kmh > 0
                             AND m.recorded_at <= c.recorded_at AND m.recorded_at > c.recorded_at - make_interval(hours => $2)),
                         c.recorded_at - make_interval(hours => $2))
              ) END AS "stoppedSince"
         FROM tracking.vehicle_current_location c
        WHERE c.vehicle_id = ANY($1::bigint[])`,
      [vehicleIds, STOPPED_LOOKBACK_HOURS],
    );
    return res.rows;
  }

  /** Open, unresolved telemetry flags of vehicles (internal ids): the newest of each type per vehicle. */
  async openFlags(db: Queryable, vehicleIds: readonly string[]): Promise<OpenFlag[]> {
    if (vehicleIds.length === 0) return [];
    const res = await db.query<OpenFlag>(
      `SELECT DISTINCT ON (f.vehicle_id, f.flag_type)
              f.vehicle_id AS "vehicleId", f.flag_type::text AS "flagType", f.severity, f.observed_at AS "observedAt"
         FROM tracking.telemetry_flags f
        WHERE f.vehicle_id = ANY($1::bigint[]) AND f.status = 'open' AND f.resolved_at IS NULL
        ORDER BY f.vehicle_id, f.flag_type, f.observed_at DESC`,
      [vehicleIds],
    );
    return res.rows;
  }

  /**
   * A vehicle's GPS history (FMS-136): its pings in [from, to], oldest first, after the cursor, at most `limit`.
   * The (vehicle, time) index serves it; (recorded_at, id) is the table's key, so the order is total.
   */
  async history(db: Queryable, vehicleId: string, query: TrackQuery): Promise<TrackPointRow[]> {
    const res = await db.query<TrackPointRow>(
      `SELECT id::text AS id, to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, recorded_at AS "recordedAt",
              latitude::float8 AS lat, longitude::float8 AS lng, speed_kmh AS "speedKmh", heading_degrees::float8 AS heading,
              altitude_m::float8 AS "altitudeM", accuracy_m::float8 AS "accuracyM", ignition_on AS "ignitionOn",
              odometer_km::float8 AS "odometerKm", source, trip_id::text AS "tripId"
         FROM tracking.gps_pings
        WHERE vehicle_id = $1
          AND ($2::timestamptz IS NULL OR recorded_at >= $2)
          AND ($3::timestamptz IS NULL OR recorded_at <= $3)
          AND ($4::timestamptz IS NULL OR (recorded_at, id) > ($4::timestamptz, $5::bigint))
        ORDER BY recorded_at, id
        LIMIT $6`,
      [vehicleId, query.from, query.to, query.cursor?.at ?? null, query.cursor?.id ?? null, query.limit],
    );
    return res.rows;
  }

  /**
   * A vehicle's stored pings recorded after `after` (exclusive; null: from `upTo` minus `lookbackMs`) up to `upTo`,
   * oldest first, at most `limit`: what the telemetry rules (FMS-46) have not seen yet.
   */
  async pingsBetween(db: Queryable, vehicleId: string, after: Date | null, upTo: Date, lookbackMs: number, limit: number): Promise<RulePing[]> {
    const res = await db.query<{ at: Date; speedKmh: number; ignitionOn: boolean | null; lat: number; lng: number; tripId: string | null }>(
      `SELECT recorded_at AS at, speed_kmh AS "speedKmh", ignition_on AS "ignitionOn", latitude::float8 AS lat, longitude::float8 AS lng,
              trip_id AS "tripId"
         FROM tracking.gps_pings
        WHERE vehicle_id = $1 AND recorded_at > COALESCE($2::timestamptz, $3::timestamptz - make_interval(secs => $4::float8 / 1000))
          AND recorded_at <= $3
        ORDER BY recorded_at
        LIMIT $5`,
      [vehicleId, after, upTo, lookbackMs, limit],
    );
    return res.rows.map((r) => ({ ...r, at: r.at.getTime() }));
  }

  /**
   * Seconds with the ignition on in [start, end), per vehicle (internal id), from device and telematics
   * pings that say whether the ignition is on (phones cannot). The time from one such ping to the next
   * counts when the first had the ignition on and the next came within `maxGapSeconds`; a longer gap (the
   * device was off, or had no signal) counts nothing. An interval across the window's edge counts only its
   * part inside, so consecutive days never count the same time twice. Vehicles with such a ping inside the
   * window are listed, with 0 when the ignition was off all along.
   */
  async ignitionSeconds(db: Queryable, start: Date, end: Date, maxGapSeconds: number): Promise<Map<string, number>> {
    const res = await db.query<{ vehicleId: string; seconds: number }>(
      `SELECT vehicle_id AS "vehicleId",
              COALESCE(sum(EXTRACT(EPOCH FROM LEAST(next_at, $2) - GREATEST(recorded_at, $1)))
                         FILTER (WHERE ignition_on AND next_at - recorded_at <= make_interval(secs => $3) AND next_at > $1 AND recorded_at < $2), 0)::float8 AS seconds
         FROM (SELECT vehicle_id, recorded_at, ignition_on,
                      lead(recorded_at) OVER (PARTITION BY vehicle_id ORDER BY recorded_at) AS next_at
                 FROM tracking.gps_pings
                WHERE source IN ('device', 'telematics') AND ignition_on IS NOT NULL
                  AND recorded_at >= $1::timestamptz - make_interval(secs => $3)
                  AND recorded_at < $2::timestamptz + make_interval(secs => $3)) p
        GROUP BY vehicle_id
       HAVING bool_or(recorded_at >= $1 AND recorded_at < $2)`,
      [start, end, maxGapSeconds],
    );
    return new Map(res.rows.map((r) => [r.vehicleId, r.seconds]));
  }

  /** Current positions of vehicles (internal ids), for the simulator's check and tests. */
  async currentLocations(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, { lat: number; lng: number; recordedAt: Date; updatedAt: Date }>> {
    const res = await db.query<{ vehicleId: string; lat: number; lng: number; recordedAt: Date; updatedAt: Date }>(
      `SELECT vehicle_id AS "vehicleId", latitude::float8 AS lat, longitude::float8 AS lng, recorded_at AS "recordedAt", updated_at AS "updatedAt"
         FROM tracking.vehicle_current_location WHERE vehicle_id = ANY($1::bigint[])`,
      [vehicleIds],
    );
    return new Map(res.rows.map(({ vehicleId, ...rest }) => [vehicleId, rest]));
  }
}
