import type { Pool, PoolClient } from 'pg';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { MlModelStatus, ServedModel } from '../domain/ml-model';

export interface MlModelListFilter extends Page {
  status?: MlModelStatus;
}

/** A registry row with internal ids; the service turns `activatedBy` into a public id. */
export interface MlModelRow {
  id: string;
  publicId: string;
  name: string;
  version: string;
  status: MlModelStatus;
  algorithm: string;
  features: string[];
  featureSpecVersion: number;
  featureSpecHash: string;
  metrics: Record<string, unknown>;
  trainingData: Record<string, unknown>;
  trainedAt: Date;
  artefactSha256: string;
  firstSeenAt: Date;
  activatedAt: Date | null;
  activatedBy: string | null;
  retiredAt: Date | null;
}

const ROW_SQL = `
  SELECT m.id, m.public_id AS "publicId", m.name, m.version, m.status, m.algorithm, m.features,
         m.feature_spec_version AS "featureSpecVersion", m.feature_spec_hash AS "featureSpecHash",
         m.metrics, m.training_data AS "trainingData", m.trained_at AS "trainedAt",
         m.artefact_sha256 AS "artefactSha256", m.first_seen_at AS "firstSeenAt",
         m.activated_at AS "activatedAt", m.activated_by AS "activatedBy", m.retired_at AS "retiredAt"
    FROM maintenance.ml_models m`;

/**
 * maintenance.ml_models (FMS-127): the models the system has used. A row is written once, when the
 * scoring job first sees its version; afterwards only its status changes. Each write is one audit row.
 */
export class MlModelRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async findByVersion(db: Queryable, name: string, version: string): Promise<MlModelRow | null> {
    const res = await db.query<MlModelRow>(`${ROW_SQL} WHERE m.name = $1 AND m.version = $2`, [name, version]);
    return res.rows[0] ?? null;
  }

  /** Registers a version the ML service serves. Throws on a version already registered (unique name and version). */
  async insert(client: PoolClient, ctx: MutationContext, m: ServedModel): Promise<void> {
    await this.mutate(
      ctx,
      'maintenance.ml_models',
      'INSERT',
      null,
      {
        name: m.name,
        version: m.version,
        algorithm: m.algorithm,
        features: JSON.stringify(m.features),
        feature_spec_version: m.featureSpecVersion,
        feature_spec_hash: m.featureSpecHash,
        metrics: JSON.stringify(m.metrics),
        training_data: JSON.stringify(m.trainingData),
        trained_at: m.trainedAt,
        artefact_sha256: m.artefactSha256,
      },
      client,
    );
  }

  async findRow(db: Queryable, publicId: string): Promise<MlModelRow | null> {
    const res = await db.query<MlModelRow>(`${ROW_SQL} WHERE m.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  /** Every model of this name, row-locked, so two activations are decided one after the other. */
  async lockName(client: PoolClient, name: string): Promise<MlModelRow[]> {
    const res = await client.query<MlModelRow>(`${ROW_SQL} WHERE m.name = $1 ORDER BY m.id FOR UPDATE`, [name]);
    return res.rows;
  }

  async retire(client: PoolClient, ctx: MutationContext, id: string, at: Date): Promise<void> {
    await this.mutate(ctx, 'maintenance.ml_models', 'UPDATE', id, { status: 'retired', retired_at: at }, client);
  }

  async activate(client: PoolClient, ctx: MutationContext, id: string, at: Date, userId: string | null): Promise<void> {
    await this.mutate(ctx, 'maintenance.ml_models', 'UPDATE', id, { status: 'active', activated_at: at, activated_by: userId, retired_at: null }, client);
  }

  /** Newest first (first seen). */
  async list(db: Queryable, f: MlModelListFilter): Promise<{ items: MlModelRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const whereSql = f.status ? `WHERE m.status = ${add(f.status)}` : '';
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM maintenance.ml_models m ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const res = await db.query<MlModelRow>(`${ROW_SQL} ${whereSql} ORDER BY m.first_seen_at DESC, m.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`, params);
    return { items: res.rows, total: count.rows[0].total };
  }
}
