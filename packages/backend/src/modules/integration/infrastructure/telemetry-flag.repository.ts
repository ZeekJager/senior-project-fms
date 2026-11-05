import type { PoolClient } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { DEFAULT_LOCATION_THRESHOLDS, type LocationThresholds } from '../domain/location-rules';
import { DEFAULT_THRESHOLDS, type RuleFlagType, type RulePing, type RuleThresholds } from '../domain/telemetry-rules';

/** The flag types the rules write: speeding and idling (FMS-46), geofences and route deviation (FMS-90). */
export type FlagType = RuleFlagType | 'geofence_violation' | 'route_deviation';

/** A flag as it was opened or closed, for its event. */
export interface FlagRecord {
  id: string;
  publicId: string;
  /** Internal ids. */
  vehicleId: string;
  geofenceId: string | null;
  flagType: FlagType;
  severity: string;
  tripId: string | null;
  observedAt: Date;
  resolvedAt: Date | null;
  details: Record<string, unknown>;
}

/** A flag as GET /vehicles/{id}/telemetry-flags lists it (internal trip id; the service makes it public). */
export interface FlagListRow {
  publicId: string;
  /** The fence of a geofence violation (FMS-90), by public id, with its name. */
  geofencePublicId: string | null;
  geofenceName: string | null;
  flagType: string;
  severity: string;
  status: string;
  tripId: string | null;
  observedAt: Date;
  resolvedAt: Date | null;
  details: Record<string, unknown>;
}

/** An open geofence or route deviation flag, as the location rules start from it. */
export interface OpenLocationFlag {
  flagType: 'geofence_violation' | 'route_deviation';
  geofenceId: string | null;
  tripId: string | null;
}

const FLAG_COLUMNS = `f.id, f.public_id AS "publicId", f.vehicle_id AS "vehicleId", f.geofence_id AS "geofenceId", f.flag_type::text AS "flagType",
       f.severity, f.trip_id AS "tripId", f.observed_at AS "observedAt", f.resolved_at AS "resolvedAt", f.details`;

/**
 * tracking.telemetry_flags as the telemetry rules write them (FMS-46, FMS-90), and tracking.rule_thresholds. Flags
 * are not audited row by row: like the pings they come from, they are derived from telemetry, and their events
 * (TelemetryFlagRaised, TelemetryFlagResolved) record each one.
 */
export class TelemetryFlagRepository {
  /** The depot's thresholds, else the fleet's (depot_id NULL), else the starting values. */
  async thresholds(db: Queryable, depotId: string | null): Promise<RuleThresholds> {
    const res = await db.query<RuleThresholds>(
      `SELECT speed_limit_kmh AS "speedLimitKmh", speeding_pings AS "speedingPings", clear_pings AS "clearPings", idle_minutes AS "idleMinutes"
         FROM tracking.rule_thresholds
        WHERE depot_id = $1 OR depot_id IS NULL
        ORDER BY depot_id NULLS LAST
        LIMIT 1`,
      [depotId],
    );
    return res.rows[0] ?? DEFAULT_THRESHOLDS;
  }

  /** Route deviation's thresholds, with the shared clear count: the depot's row, else the fleet's, else the starting values. */
  async locationThresholds(db: Queryable, depotId: string | null): Promise<LocationThresholds> {
    const res = await db.query<LocationThresholds>(
      `SELECT route_deviation_m AS "routeDeviationM", route_deviation_pings AS "routeDeviationPings", clear_pings AS "clearPings"
         FROM tracking.rule_thresholds
        WHERE depot_id = $1 OR depot_id IS NULL
        ORDER BY depot_id NULLS LAST
        LIMIT 1`,
      [depotId],
    );
    return res.rows[0] ?? DEFAULT_LOCATION_THRESHOLDS;
  }

  /** The flag types the vehicle has open (condition ongoing), whoever reviewed them. */
  async ongoingTypes(db: Queryable, vehicleId: string): Promise<Set<RuleFlagType>> {
    const res = await db.query<{ flagType: RuleFlagType }>(
      `SELECT flag_type::text AS "flagType" FROM tracking.telemetry_flags
        WHERE vehicle_id = $1 AND resolved_at IS NULL AND flag_type IN ('speeding', 'idling')`,
      [vehicleId],
    );
    return new Set(res.rows.map((r) => r.flagType));
  }

  /** The vehicle's open geofence and route deviation flags (FMS-90): of which fence, and on which trip. */
  async ongoingLocation(db: Queryable, vehicleId: string): Promise<OpenLocationFlag[]> {
    const res = await db.query<OpenLocationFlag>(
      `SELECT flag_type::text AS "flagType", geofence_id AS "geofenceId", trip_id AS "tripId" FROM tracking.telemetry_flags
        WHERE vehicle_id = $1 AND resolved_at IS NULL AND flag_type IN ('geofence_violation', 'route_deviation')`,
      [vehicleId],
    );
    return res.rows;
  }

  /**
   * Opens a flag. Null if the vehicle already has one of the type (and fence) open (ux_telemetry_flags_ongoing):
   * the rule ran twice, or the flag was opened meanwhile.
   */
  async raise(
    client: PoolClient,
    flag: { vehicleId: string; flagType: FlagType; geofenceId?: string | null; severity: string; observedAt: Date; ping: RulePing; details: Record<string, unknown> },
  ): Promise<FlagRecord | null> {
    const details = { ...flag.details, lat: flag.ping.lat, lng: flag.ping.lng, flagged_at: new Date(flag.ping.at).toISOString() };
    const res = await client.query<FlagRecord>(
      `INSERT INTO tracking.telemetry_flags AS f (vehicle_id, trip_id, flag_type, geofence_id, severity, observed_at, details)
       VALUES ($1, $2, $3::tracking.telemetry_flag_type, $4, $5, $6, $7)
       ON CONFLICT (vehicle_id, flag_type, geofence_id) WHERE resolved_at IS NULL DO NOTHING
       RETURNING ${FLAG_COLUMNS}`,
      [flag.vehicleId, flag.ping.tripId, flag.flagType, flag.geofenceId ?? null, flag.severity, flag.observedAt, details],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Closes the vehicle's open flag of the type (and fence): when the condition ended, why, how long it lasted and,
   * for speeding, the top speed between its start and end, with any `details` the rule adds. Null if none was open
   * (already closed).
   */
  async resolve(
    client: PoolClient,
    vehicleId: string,
    flagType: FlagType,
    resolvedAt: Date,
    reason: string,
    opts: { geofenceId?: string | null; details?: Record<string, unknown> } = {},
  ): Promise<FlagRecord | null> {
    const res = await client.query<FlagRecord>(
      `UPDATE tracking.telemetry_flags AS f
          SET resolved_at = greatest($3::timestamptz, f.observed_at),
              details = f.details || jsonb_strip_nulls(jsonb_build_object(
                'end_reason', $4::text,
                'duration_seconds', round(extract(epoch FROM greatest($3::timestamptz, f.observed_at) - f.observed_at)),
                'max_speed_kmh', CASE WHEN f.flag_type = 'speeding' THEN (
                  SELECT max(p.speed_kmh) FROM tracking.gps_pings p
                   WHERE p.vehicle_id = f.vehicle_id AND p.recorded_at >= f.observed_at AND p.recorded_at <= $3::timestamptz) END)) || $6::jsonb
        WHERE f.vehicle_id = $1 AND f.flag_type = $2::tracking.telemetry_flag_type AND f.resolved_at IS NULL
          AND f.geofence_id IS NOT DISTINCT FROM $5::bigint
       RETURNING ${FLAG_COLUMNS}`,
      [vehicleId, flagType, resolvedAt, reason, opts.geofenceId ?? null, opts.details ?? {}],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Closes every vehicle's open flag of a fence that was changed or removed (FMS-90), at `at`: the rules judge the
   * fence afresh from each vehicle's next crossing.
   */
  async resolveForGeofence(client: PoolClient, geofenceId: string, at: Date, reason: 'geofence_changed' | 'geofence_removed'): Promise<FlagRecord[]> {
    const res = await client.query<FlagRecord>(
      `UPDATE tracking.telemetry_flags AS f
          SET resolved_at = greatest($2::timestamptz, f.observed_at),
              details = f.details || jsonb_build_object('end_reason', $3::text,
                'duration_seconds', round(extract(epoch FROM greatest($2::timestamptz, f.observed_at) - f.observed_at)))
        WHERE f.geofence_id = $1 AND f.resolved_at IS NULL
       RETURNING ${FLAG_COLUMNS}`,
      [geofenceId, at, reason],
    );
    return res.rows;
  }

  /** A vehicle's flags, newest first, optionally of some types and observed within a period. */
  async listForVehicle(
    db: Queryable,
    vehicleId: string,
    filter: { types: readonly string[] | null; from: Date | null; to: Date | null; ongoing: boolean | null; limit: number },
  ): Promise<FlagListRow[]> {
    const res = await db.query<FlagListRow>(
      `SELECT f.public_id AS "publicId", g.public_id AS "geofencePublicId", g.name AS "geofenceName", f.flag_type::text AS "flagType",
              f.severity, f.status::text AS status, f.trip_id AS "tripId", f.observed_at AS "observedAt", f.resolved_at AS "resolvedAt", f.details
         FROM tracking.telemetry_flags f
         LEFT JOIN tracking.geofences g ON g.id = f.geofence_id
        WHERE f.vehicle_id = $1
          AND ($2::text[] IS NULL OR f.flag_type::text = ANY($2::text[]))
          AND ($3::timestamptz IS NULL OR f.observed_at >= $3)
          AND ($4::timestamptz IS NULL OR f.observed_at < $4)
          AND ($5::boolean IS NULL OR (f.resolved_at IS NULL) = $5)
        ORDER BY f.observed_at DESC, f.id DESC
        LIMIT $6`,
      [vehicleId, filter.types, filter.from, filter.to, filter.ongoing, filter.limit],
    );
    return res.rows;
  }
}
