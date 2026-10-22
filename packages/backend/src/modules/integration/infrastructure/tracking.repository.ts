import type { PoolClient } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { PingSource } from '../domain/gps';

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
   */
  async insertPings(client: PoolClient, rows: readonly PingRow[]): Promise<{ vehicleId: string; recordedAt: Date }[]> {
    if (rows.length === 0) return [];
    const col = <K extends keyof PingRow>(key: K) => rows.map((r) => r[key]);
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
