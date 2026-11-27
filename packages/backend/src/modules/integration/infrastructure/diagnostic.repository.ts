import type { PoolClient } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DiagnosticProtocol, DiagnosticSeverity } from '../domain/diagnostics';

export interface DiagnosticRow {
  id: string;
  publicId: string;
  vehicleId: string;
  protocol: DiagnosticProtocol;
  code: string;
  spn: number | null;
  fmi: number | null;
  description: string | null;
  severity: DiagnosticSeverity;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrences: number;
  clearedAt: Date | null;
  providerCode: string | null;
}

const COLUMNS = `c.id::text AS id, c.public_id AS "publicId", c.vehicle_id::text AS "vehicleId", c.protocol, c.code, c.spn, c.fmi,
  c.description, c.severity, c.first_seen_at AS "firstSeenAt", c.last_seen_at AS "lastSeenAt", c.occurrences,
  c.cleared_at AS "clearedAt", p.code AS "providerCode"`;
const FROM = 'tracking.diagnostic_codes c LEFT JOIN integration.external_providers p ON p.id = c.provider_id';

export interface NewDiagnostic {
  vehicleId: string;
  providerId: string;
  deviceId: string;
  protocol: DiagnosticProtocol;
  code: string;
  spn: number | null;
  fmi: number | null;
  description: string | null;
  severity: DiagnosticSeverity;
  observedAt: Date;
}

/**
 * tracking.diagnostic_codes and its dictionary (FMS-132). Written only by a telematics delivery's consumer, on its
 * transaction; the batch is audited as one entry (tracking.diagnostics_ingested), as positions are.
 */
export class DiagnosticRepository {
  /** The dictionary's description and severity for each key (`protocol:code`; J1939 by SPN). */
  async dictionary(db: Queryable, keys: readonly { protocol: DiagnosticProtocol; code: string }[]): Promise<Map<string, { description: string; severity: DiagnosticSeverity }>> {
    if (keys.length === 0) return new Map();
    const res = await db.query<{ protocol: DiagnosticProtocol; code: string; description: string; severity: DiagnosticSeverity }>(
      `SELECT d.protocol, d.code, d.description, d.severity
         FROM tracking.diagnostic_code_dictionary d
         JOIN unnest($1::text[], $2::text[]) AS k(protocol, code) ON d.protocol::text = k.protocol AND d.code = k.code`,
      [keys.map((k) => k.protocol), keys.map((k) => k.code)],
    );
    return new Map(res.rows.map((r) => [`${r.protocol}:${r.code}`, { description: r.description, severity: r.severity }]));
  }

  /** The vehicle's active row for the code, locked. */
  async lockActive(client: PoolClient, vehicleId: string, protocol: DiagnosticProtocol, code: string): Promise<DiagnosticRow | null> {
    const res = await client.query<DiagnosticRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE c.vehicle_id = $1 AND c.protocol = $2 AND c.code = $3 AND c.cleared_at IS NULL FOR UPDATE OF c`,
      [vehicleId, protocol, code],
    );
    return res.rows[0] ?? null;
  }

  /** When the vehicle's code was last cleared, if it ever was. */
  async lastCleared(db: Queryable, vehicleId: string, protocol: DiagnosticProtocol, code: string): Promise<Date | null> {
    const res = await db.query<{ at: Date | null }>(
      'SELECT max(cleared_at) AS at FROM tracking.diagnostic_codes WHERE vehicle_id = $1 AND protocol = $2 AND code = $3',
      [vehicleId, protocol, code],
    );
    return res.rows[0]?.at ?? null;
  }

  async insert(client: PoolClient, row: NewDiagnostic): Promise<{ id: string; publicId: string }> {
    const res = await client.query<{ id: string; publicId: string }>(
      `INSERT INTO tracking.diagnostic_codes
         (vehicle_id, provider_id, gps_device_id, protocol, code, spn, fmi, description, severity, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING id::text AS id, public_id AS "publicId"`,
      [row.vehicleId, row.providerId, row.deviceId, row.protocol, row.code, row.spn, row.fmi, row.description, row.severity, row.observedAt],
    );
    return res.rows[0];
  }

  /** One more occurrence: the seen period widened to `at`. */
  async repeat(client: PoolClient, id: string, at: Date): Promise<void> {
    await client.query(
      `UPDATE tracking.diagnostic_codes
          SET occurrences = occurrences + 1, first_seen_at = least(first_seen_at, $2), last_seen_at = greatest(last_seen_at, $2)
        WHERE id = $1`,
      [id, at],
    );
  }

  async clear(client: PoolClient, id: string, at: Date): Promise<void> {
    await client.query('UPDATE tracking.diagnostic_codes SET cleared_at = $2 WHERE id = $1', [id, at]);
  }

  /** A vehicle's codes, the latest seen first: active, cleared or both. */
  async forVehicle(db: Queryable, vehicleId: string, query: { status: 'active' | 'cleared' | null; limit: number }): Promise<DiagnosticRow[]> {
    const status = query.status === 'active' ? 'AND c.cleared_at IS NULL' : query.status === 'cleared' ? 'AND c.cleared_at IS NOT NULL' : '';
    const res = await db.query<DiagnosticRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE c.vehicle_id = $1 ${status} ORDER BY c.cleared_at IS NULL DESC, c.last_seen_at DESC, c.id DESC LIMIT $2`,
      [vehicleId, query.limit],
    );
    return res.rows;
  }
}
