import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { ProviderType } from '../domain/adapter';
import type { SyncDirection, SyncLogView, SyncStatus, SyncTrigger } from '../domain/provider';

/** An integration.external_providers row. `configuration` holds settings only; secrets are in the environment. */
export interface ProviderRow {
  id: string;
  publicId: string;
  code: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string | null;
  isActive: boolean;
  configuration: Record<string, unknown>;
}

/** An integration.sync_logs row. `metadata` holds the trigger, a webhook's kind and normalised data, a sync's record count. */
export interface SyncLogRow {
  id: string;
  publicId: string;
  providerId: string | null;
  direction: SyncDirection;
  status: SyncStatus;
  externalReference: string | null;
  requestId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  metadata: SyncMetadata;
}

export interface SyncMetadata {
  trigger?: SyncTrigger;
  kind?: string;
  records?: number;
  /** A webhook's: when it happened at the provider, and its normalised data. */
  occurred_at?: string | null;
  data?: Record<string, unknown>;
}

export interface SyncLogWrite {
  provider_id: string;
  integration_name: string;
  direction: SyncDirection;
  status: SyncStatus;
  external_reference: string | null;
  request_id: string;
  completed_at: Date | null;
  error_message: string | null;
  metadata: SyncMetadata;
}

/** The latest outcomes of a provider, from its sync logs. */
export interface ProviderOutcomes {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  lastSync: SyncLogRow | null;
}

const PROVIDER_SQL = `
  SELECT p.id, p.public_id AS "publicId", p.code, p.name, p.provider_type AS "providerType", p.base_url AS "baseUrl",
         p.is_active AS "isActive", p.configuration
    FROM integration.external_providers p`;

const SYNC_COLUMNS = `
         s.id, s.public_id AS "publicId", s.provider_id AS "providerId", s.direction, s.status,
         s.external_reference AS "externalReference", s.request_id AS "requestId", s.started_at AS "startedAt",
         s.completed_at AS "completedAt", s.error_message AS "errorMessage", s.metadata`;

const SYNC_SQL = `SELECT ${SYNC_COLUMNS} FROM integration.sync_logs s`;

/** The unique index that makes a redelivered webhook a duplicate (migration 031). */
export const INBOUND_REFERENCE_INDEX = 'ux_integration_sync_logs_inbound_reference';

/** integration.external_providers and integration.sync_logs (FMS-85). */
export class IntegrationRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** For reads outside a transaction. */
  pool(): Queryable {
    return this.db;
  }

  async listProviders(db: Queryable): Promise<ProviderRow[]> {
    return (await db.query<ProviderRow>(`${PROVIDER_SQL} ORDER BY p.name, p.id`)).rows;
  }

  async findProvider(db: Queryable, publicId: string): Promise<ProviderRow | null> {
    return (await db.query<ProviderRow>(`${PROVIDER_SQL} WHERE p.public_id = $1`, [publicId])).rows[0] ?? null;
  }

  async findProviderByCode(db: Queryable, code: string): Promise<ProviderRow | null> {
    return (await db.query<ProviderRow>(`${PROVIDER_SQL} WHERE p.code = $1`, [code])).rows[0] ?? null;
  }

  /**
   * Each provider's last success, last failure (with its message) and last sync: three indexed
   * queries, one after the other (`db` may be a single connection).
   */
  async outcomes(db: Queryable, providerIds: readonly string[]): Promise<Map<string, ProviderOutcomes>> {
    const result = new Map<string, ProviderOutcomes>(providerIds.map((id) => [id, { lastSuccessAt: null, lastFailureAt: null, lastError: null, lastSync: null }]));
    if (providerIds.length === 0) return result;
    const successes = await db.query<{ providerId: string; at: Date }>(
      `SELECT provider_id AS "providerId", max(coalesce(completed_at, started_at)) AS at
         FROM integration.sync_logs
        WHERE provider_id = ANY($1::bigint[]) AND status IN ('succeeded', 'partial')
        GROUP BY provider_id`,
      [providerIds],
    );
    const failures = await db.query<{ providerId: string; at: Date; error: string | null }>(
      `SELECT DISTINCT ON (provider_id) provider_id AS "providerId", coalesce(completed_at, started_at) AS at, error_message AS error
         FROM integration.sync_logs
        WHERE provider_id = ANY($1::bigint[]) AND status = 'failed'
        ORDER BY provider_id, started_at DESC, id DESC`,
      [providerIds],
    );
    const syncs = await db.query<SyncLogRow>(
      `SELECT DISTINCT ON (s.provider_id) ${SYNC_COLUMNS}
         FROM integration.sync_logs s
        WHERE s.provider_id = ANY($1::bigint[]) AND s.direction = 'outbound'
        ORDER BY s.provider_id, s.started_at DESC, s.id DESC`,
      [providerIds],
    );
    for (const r of successes.rows) result.get(r.providerId)!.lastSuccessAt = r.at;
    for (const r of failures.rows) Object.assign(result.get(r.providerId)!, { lastFailureAt: r.at, lastError: r.error });
    for (const r of syncs.rows) result.get(r.providerId as string)!.lastSync = r;
    return result;
  }

  /** A sync of the provider still running, started after `since`: a second request joins it. */
  async runningSync(db: Queryable, providerId: string, since: Date): Promise<SyncLogRow | null> {
    const res = await db.query<SyncLogRow>(
      `${SYNC_SQL} WHERE s.provider_id = $1 AND s.status = 'started' AND s.direction = 'outbound' AND s.started_at >= $2 ORDER BY s.started_at DESC LIMIT 1`,
      [providerId, since],
    );
    return res.rows[0] ?? null;
  }

  async findInbound(db: Queryable, providerId: string, externalReference: string): Promise<SyncLogRow | null> {
    const res = await db.query<SyncLogRow>(`${SYNC_SQL} WHERE s.provider_id = $1 AND s.direction = 'inbound' AND s.external_reference = $2`, [
      providerId,
      externalReference,
    ]);
    return res.rows[0] ?? null;
  }

  async findSyncLog(db: Queryable, id: string): Promise<SyncLogRow> {
    return (await db.query<SyncLogRow>(`${SYNC_SQL} WHERE s.id = $1`, [id])).rows[0];
  }

  async findSyncLogByPublicId(db: Queryable, publicId: string): Promise<SyncLogRow | null> {
    return (await db.query<SyncLogRow>(`${SYNC_SQL} WHERE s.public_id = $1`, [publicId])).rows[0] ?? null;
  }

  /** A stored webhook delivery with its provider, for the consumer of IntegrationWebhookReceived. */
  async delivery(
    db: Queryable,
    syncLogPublicId: string,
  ): Promise<{
    providerCode: string;
    providerType: ProviderType;
    eventId: string | null;
    metadata: SyncMetadata;
  } | null> {
    const res = await db.query<{
      providerCode: string;
      providerType: ProviderType;
      eventId: string | null;
      metadata: SyncMetadata;
    }>(
      `SELECT p.code AS "providerCode", p.provider_type AS "providerType", s.external_reference AS "eventId", s.metadata
         FROM integration.sync_logs s
         JOIN integration.external_providers p ON p.id = s.provider_id
        WHERE s.public_id = $1 AND s.direction = 'inbound'`,
      [syncLogPublicId],
    );
    return res.rows[0] ?? null;
  }

  insertSyncLog(ctx: MutationContext, data: SyncLogWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'integration.sync_logs', 'INSERT', null, { ...data }, client);
  }

  completeSyncLog(
    ctx: MutationContext,
    id: string,
    data: {
      status: SyncStatus;
      completed_at: Date;
      error_message: string | null;
      external_reference?: string | null;
      metadata: SyncMetadata;
    },
    client: PoolClient,
  ): Promise<Row> {
    return this.mutate(ctx, 'integration.sync_logs', 'UPDATE', id, { ...data }, client);
  }
}

/** A sync log as the API returns it: the trigger, kind and count from its metadata, never the stored data. */
export function syncLogView(row: SyncLogRow, providerPublicId: string | null): SyncLogView {
  return {
    id: row.publicId,
    provider_id: providerPublicId,
    direction: row.direction,
    status: row.status,
    trigger: row.metadata.trigger ?? null,
    kind: row.metadata.kind ?? null,
    records: row.metadata.records ?? null,
    external_reference: row.externalReference,
    request_id: row.requestId,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    error_message: row.errorMessage,
  };
}
