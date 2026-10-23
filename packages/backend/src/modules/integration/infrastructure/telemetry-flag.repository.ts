import type { PoolClient } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { DEFAULT_THRESHOLDS, type RuleFlagType, type RulePing, type RuleThresholds } from '../domain/telemetry-rules';

/** A flag as it was opened or closed, for its event. */
export interface FlagRecord {
  id: string;
  publicId: string;
  flagType: RuleFlagType;
  severity: string;
  tripId: string | null;
  observedAt: Date;
  resolvedAt: Date | null;
  details: Record<string, unknown>;
}

/** A flag as GET /vehicles/{id}/telemetry-flags lists it (internal trip id; the service makes it public). */
export interface FlagListRow {
  publicId: string;
  flagType: string;
  severity: string;
  status: string;
  tripId: string | null;
  observedAt: Date;
  resolvedAt: Date | null;
  details: Record<string, unknown>;
}

const FLAG_COLUMNS = `f.id, f.public_id AS "publicId", f.flag_type::text AS "flagType", f.severity, f.trip_id AS "tripId",
       f.observed_at AS "observedAt", f.resolved_at AS "resolvedAt", f.details`;

/**
 * tracking.telemetry_flags as the telemetry rules write them (FMS-46), and tracking.rule_thresholds. Flags are
 * not audited row by row: like the pings they come from, they are derived from telemetry, and their events
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

  /** The flag types the vehicle has open (condition ongoing), whoever reviewed them. */
  async ongoingTypes(db: Queryable, vehicleId: string): Promise<Set<RuleFlagType>> {
    const res = await db.query<{ flagType: RuleFlagType }>(
      `SELECT flag_type::text AS "flagType" FROM tracking.telemetry_flags
        WHERE vehicle_id = $1 AND resolved_at IS NULL AND flag_type IN ('speeding', 'idling')`,
      [vehicleId],
    );
    return new Set(res.rows.map((r) => r.flagType));
  }

  /**
   * Opens a flag. Null if the vehicle already has one of the type open (ux_telemetry_flags_ongoing): the rule
   * ran twice, or the flag was opened meanwhile.
   */
  async raise(
    client: PoolClient,
    flag: { vehicleId: string; flagType: RuleFlagType; severity: string; observedAt: Date; ping: RulePing; details: Record<string, unknown> },
  ): Promise<FlagRecord | null> {
    const details = { ...flag.details, lat: flag.ping.lat, lng: flag.ping.lng, flagged_at: new Date(flag.ping.at).toISOString() };
    const res = await client.query<FlagRecord>(
      `INSERT INTO tracking.telemetry_flags AS f (vehicle_id, trip_id, flag_type, severity, observed_at, details)
       VALUES ($1, $2, $3::tracking.telemetry_flag_type, $4, $5, $6)
       ON CONFLICT (vehicle_id, flag_type) WHERE resolved_at IS NULL DO NOTHING
       RETURNING ${FLAG_COLUMNS}`,
      [flag.vehicleId, flag.ping.tripId, flag.flagType, flag.severity, flag.observedAt, details],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Closes the vehicle's open flag of the type: when the condition ended, why, how long it lasted and, for
   * speeding, the top speed between its start and end. Null if none was open (already closed).
   */
  async resolve(client: PoolClient, vehicleId: string, flagType: RuleFlagType, resolvedAt: Date, reason: string): Promise<FlagRecord | null> {
    const res = await client.query<FlagRecord>(
      `UPDATE tracking.telemetry_flags AS f
          SET resolved_at = greatest($3::timestamptz, f.observed_at),
              details = f.details || jsonb_strip_nulls(jsonb_build_object(
                'end_reason', $4::text,
                'duration_seconds', round(extract(epoch FROM greatest($3::timestamptz, f.observed_at) - f.observed_at)),
                'max_speed_kmh', CASE WHEN f.flag_type = 'speeding' THEN (
                  SELECT max(p.speed_kmh) FROM tracking.gps_pings p
                   WHERE p.vehicle_id = f.vehicle_id AND p.recorded_at >= f.observed_at AND p.recorded_at <= $3::timestamptz) END))
        WHERE f.vehicle_id = $1 AND f.flag_type = $2::tracking.telemetry_flag_type AND f.resolved_at IS NULL
       RETURNING ${FLAG_COLUMNS}`,
      [vehicleId, flagType, resolvedAt, reason],
    );
    return res.rows[0] ?? null;
  }

  /** A vehicle's flags, newest first, optionally of some types and observed within a period. */
  async listForVehicle(
    db: Queryable,
    vehicleId: string,
    filter: { types: readonly string[] | null; from: Date | null; to: Date | null; ongoing: boolean | null; limit: number },
  ): Promise<FlagListRow[]> {
    const res = await db.query<FlagListRow>(
      `SELECT f.public_id AS "publicId", f.flag_type::text AS "flagType", f.severity, f.status::text AS status, f.trip_id AS "tripId",
              f.observed_at AS "observedAt", f.resolved_at AS "resolvedAt", f.details
         FROM tracking.telemetry_flags f
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
