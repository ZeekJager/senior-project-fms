import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { DocumentContentType, DocumentOwnerType, DocumentType } from '../domain/document';

/** A live document.documents row. Dates are `YYYY-MM-DD` text. */
export interface DocumentRow {
  id: string;
  publicId: string;
  ownerType: DocumentOwnerType;
  ownerId: string;
  documentType: DocumentType;
  storageKey: string;
  originalFilename: string | null;
  contentType: DocumentContentType;
  sizeBytes: number;
  sha256: string;
  expiresOn: string | null;
  retainUntil: string | null;
  uploadedBy: string;
  uploadedAt: Date;
}

export interface DocumentInsert {
  owner_type: DocumentOwnerType;
  owner_id: string;
  document_type: DocumentType;
  storage_key: string;
  original_filename: string | null;
  content_type: DocumentContentType;
  size_bytes: number;
  sha256: string;
  expires_on: string | null;
  retain_until: string | null;
  uploaded_by: string;
}

const ROW_SQL = `
  SELECT id, public_id AS "publicId", owner_type AS "ownerType", owner_id AS "ownerId",
         document_type AS "documentType", storage_key AS "storageKey", original_filename AS "originalFilename",
         content_type AS "contentType", size_bytes AS "sizeBytes", sha256, expires_on::text AS "expiresOn",
         retain_until::text AS "retainUntil", uploaded_by AS "uploadedBy", uploaded_at AS "uploadedAt"
    FROM document.documents`;

/**
 * document.documents (owned by the fleet module, CONVENTIONS.md). Deleted
 * documents are invisible here; their files stay until retain_until.
 */
export class DocumentRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async findLive(db: Queryable, publicId: string): Promise<DocumentRow | null> {
    const res = await db.query<DocumentRow>(`${ROW_SQL} WHERE public_id = $1 AND deleted_at IS NULL`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<DocumentRow> {
    const res = await db.query<DocumentRow>(`${ROW_SQL} WHERE id = $1`, [id]);
    return res.rows[0];
  }

  insert(ctx: MutationContext, data: DocumentInsert, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'document.documents', 'INSERT', null, { ...data }, client);
  }

  /** Soft delete: deleted_at / deleted_by, one audited change. The file is kept (retention). */
  softDelete(ctx: MutationContext, id: string, deletedBy: string, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'document.documents', 'DELETE', id, { deleted_by: deletedBy }, client);
  }
}
