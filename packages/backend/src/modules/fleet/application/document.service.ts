import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { depotInScope, depotScope, type Scope } from '../../../shared/authz/scope';
import { createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DocumentStorage } from '../../../shared/storage/document-storage';
import type { UserAccount } from '../../auth';
import {
  DOCUMENT_EVENTS,
  MAX_DOCUMENT_BYTES,
  cleanFilename,
  documentNotFound,
  fileTooLarge,
  linkExpired,
  linkInvalid,
  ownerNotFound,
  sniffContentType,
  unsupportedMediaType,
  type DocumentContentType,
  type DocumentOwnerType,
  type DocumentType,
  type DocumentView,
} from '../domain/document';
import type { DocumentRepository, DocumentRow } from '../infrastructure/document.repository';
import type { DriverRow } from '../infrastructure/driver.repository';
import type { Caller } from './caller';
import type { DocumentUrlSigner } from './document-url';

export interface DocumentUpload {
  owner_type: DocumentOwnerType;
  /** The vehicle's or driver's public id. */
  owner_id: string;
  document_type: DocumentType;
  expires_on?: string;
  retain_until?: string;
  file: { bytes: Buffer; originalName?: string };
}

/** GET /documents/{id}: the metadata and a link to the bytes, valid one hour. */
export type DocumentWithUrl = DocumentView & { url: string; url_expires_at: Date };

export interface DocumentServiceDeps {
  documents: Pick<DocumentRepository, 'inTransaction' | 'findLive' | 'findById' | 'listForOwners' | 'insert' | 'softDelete'>;
  storage: DocumentStorage;
  urls: DocumentUrlSigner;
  vehicles: {
    findRef(db: Queryable, by: { publicId: string } | { id: string }, scope: Scope): Promise<{ id: string; publicId: string } | null>;
    findRefs(db: Queryable, publicIds: readonly string[], scope: Scope): Promise<{ id: string; publicId: string }[]>;
  };
  drivers: {
    findByPublicId(db: Queryable, publicId: string): Promise<DriverRow | null>;
    findByPublicIds(db: Queryable, publicIds: readonly string[]): Promise<DriverRow[]>;
    findById(db: Queryable, id: string): Promise<DriverRow | null>;
  };
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<UserAccount[]> };
  events: EventBus;
}

type OwnerRef = { publicId: string } | { id: string };

/**
 * Vehicle and driver documents (FMS-17): registrations, licences, insurance.
 * A caller reaches a document only through its owner: whoever may read the
 * vehicle or driver may read its documents, and nobody else sees that it
 * exists (404).
 */
export class DocumentService {
  constructor(private readonly deps: DocumentServiceDeps) {}

  /**
   * POST /documents. The type comes from the file's bytes (JPEG, PNG or PDF,
   * else 415), the key is random, and the file is stored before the row is
   * written; if the row cannot be written, the file is removed again.
   */
  async upload(caller: Caller, input: DocumentUpload): Promise<DocumentView> {
    const { documents, storage } = this.deps;
    const bytes = input.file.bytes;
    if (bytes.length > MAX_DOCUMENT_BYTES) throw fileTooLarge();
    const contentType = sniffContentType(bytes);
    if (!contentType) throw unsupportedMediaType();

    const owner = await documents.inTransaction((client) => this.readableOwner(client, caller, input.owner_type, { publicId: input.owner_id }));
    if (!owner) throw ownerNotFound();

    const now = new Date();
    const key = `documents/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    await storage.put(key, bytes, contentType);

    let view: DocumentView;
    try {
      view = await documents.inTransaction(async (client) => {
        const row = await documents.insert(
          mutationContext(caller),
          {
            owner_type: input.owner_type,
            owner_id: owner.id,
            document_type: input.document_type,
            storage_key: key,
            original_filename: cleanFilename(input.file.originalName),
            content_type: contentType,
            size_bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            expires_on: input.expires_on ?? null,
            retain_until: input.retain_until ?? null,
            uploaded_by: caller.user.id!,
          },
          client,
        );
        return this.view(client, await documents.findById(client, row.id as string), owner.publicId);
      });
    } catch (err) {
      await storage.remove(key).catch(() => {});
      throw err;
    }

    await this.deps.events.publish([
      createEvent(
        DOCUMENT_EVENTS.uploaded,
        {
          document_id: view.id,
          owner_type: view.owner_type,
          owner_id: view.owner_id,
          document_type: view.document_type,
          expires_on: view.expires_on,
        },
        { actor: caller.user.publicId, correlationId: caller.correlationId },
      ),
    ]);
    return view;
  }

  /** GET /documents/{id}: 404 for a deleted document or one whose owner the caller cannot read. */
  async get(caller: Caller, documentId: string): Promise<DocumentWithUrl> {
    const view = await this.deps.documents.inTransaction(async (client) => {
      const { row, owner } = await this.readable(client, caller, documentId);
      return this.view(client, row, owner.publicId);
    });
    const link = this.deps.urls.sign(view.id);
    return { ...view, url: link.url, url_expires_at: link.expiresAt };
  }

  /**
   * GET /documents?owner_type=&owner_id=a,b: the live documents of the listed
   * owners, soonest expiry first. Owners the caller cannot read are left out,
   * as if they had no documents, so the answer reveals nothing about them.
   */
  async list(caller: Caller, ownerType: DocumentOwnerType, ownerIds: readonly string[]): Promise<DocumentView[]> {
    const { documents } = this.deps;
    return documents.inTransaction(async (client) => {
      const owners = await this.readableOwners(client, caller, ownerType, [...new Set(ownerIds)]);
      const publicIds = new Map(owners.map((o) => [o.id, o.publicId]));
      const rows = await documents.listForOwners(client, ownerType, [...publicIds.keys()]);
      return this.views(client, rows, (row) => publicIds.get(row.ownerId)!);
    });
  }

  /**
   * GET /documents/{id}/content: the bytes, for a valid unexpired signed
   * link. No session is needed; the signature is the permission, checked
   * when the link was issued.
   */
  async content(
    documentId: string,
    expires: string | undefined,
    signature: string | undefined,
  ): Promise<{ stream: Readable; contentType: DocumentContentType; sizeBytes: number; filename: string | null }> {
    const check = this.deps.urls.verify(documentId, expires, signature);
    if (check === 'expired') throw linkExpired();
    if (check === 'invalid') throw linkInvalid();
    const row = await this.deps.documents.inTransaction((client) => this.deps.documents.findLive(client, documentId));
    if (!row) throw documentNotFound();
    return { stream: await this.deps.storage.get(row.storageKey), contentType: row.contentType, sizeBytes: row.sizeBytes, filename: row.originalFilename };
  }

  /** DELETE /documents/{id}: soft delete, one audit row. The file stays (retain_until). */
  async remove(caller: Caller, documentId: string): Promise<void> {
    const { documents } = this.deps;
    await documents.inTransaction(async (client) => {
      const { row } = await this.readable(client, caller, documentId);
      await documents.softDelete(mutationContext(caller), row.id, caller.user.id!, client);
    });
  }

  private async readable(client: Queryable, caller: Caller, documentId: string): Promise<{ row: DocumentRow; owner: { id: string; publicId: string } }> {
    const row = await this.deps.documents.findLive(client, documentId);
    const owner = row && (await this.readableOwner(client, caller, row.ownerType, { id: row.ownerId }));
    if (!row || !owner) throw documentNotFound();
    return { row, owner };
  }

  /**
   * The owner, if the caller may read it: a vehicle needs vehicle:read and
   * the caller's depot scope; a driver is readable by themselves, or with
   * driver:read and their home depot in scope. Retired owners count: their
   * documents are history.
   */
  private async readableOwner(
    db: Queryable,
    caller: Caller,
    ownerType: DocumentOwnerType,
    ref: OwnerRef,
  ): Promise<{ id: string; publicId: string } | null> {
    const { user } = caller;
    if (ownerType === 'vehicle') {
      if (!user.permissions.includes('vehicle:read')) return null;
      return this.deps.vehicles.findRef(db, ref, depotScope(user));
    }

    const driver = 'publicId' in ref ? await this.deps.drivers.findByPublicId(db, ref.publicId) : await this.deps.drivers.findById(db, ref.id);
    if (!driver) return null;
    if (driver.userId === user.id) return { id: driver.id, publicId: driver.publicId };
    if (!user.permissions.includes('driver:read')) return null;
    const [account] = await this.deps.users.findByIds(db, [driver.userId]);
    return account && depotInScope(depotScope(user), account.depotId) ? { id: driver.id, publicId: driver.publicId } : null;
  }

  /** The owners among `publicIds` the caller may read (see readableOwner); one query for vehicles. */
  private async readableOwners(
    db: Queryable,
    caller: Caller,
    ownerType: DocumentOwnerType,
    publicIds: readonly string[],
  ): Promise<{ id: string; publicId: string }[]> {
    if (ownerType === 'vehicle') {
      if (!caller.user.permissions.includes('vehicle:read')) return [];
      return this.deps.vehicles.findRefs(db, publicIds, depotScope(caller.user));
    }
    // Drivers: the same rule as readableOwner, with one query for the drivers and one for their accounts.
    const { user } = caller;
    const drivers = await this.deps.drivers.findByPublicIds(db, publicIds);
    const mayRead = user.permissions.includes('driver:read');
    const accounts = mayRead ? await this.deps.users.findByIds(db, drivers.map((d) => d.userId)) : [];
    const depotOf = new Map(accounts.map((a) => [a.id, a.depotId]));
    const scope = depotScope(user);
    return drivers
      .filter((d) => d.userId === user.id || (mayRead && depotOf.has(d.userId) && depotInScope(scope, depotOf.get(d.userId)!)))
      .map((d) => ({ id: d.id, publicId: d.publicId }));
  }

  private async view(db: Queryable, row: DocumentRow, ownerPublicId: string): Promise<DocumentView> {
    const [view] = await this.views(db, [row], () => ownerPublicId);
    return view;
  }

  /** Views of several rows, with one lookup of their uploaders. */
  private async views(db: Queryable, rows: DocumentRow[], ownerPublicId: (row: DocumentRow) => string): Promise<DocumentView[]> {
    if (rows.length === 0) return [];
    const uploaders = await this.deps.users.findByIds(db, [...new Set(rows.map((r) => r.uploadedBy))]);
    const uploaderPublicIds = new Map(uploaders.map((u) => [u.id, u.publicId]));
    return rows.map((row) => ({
      id: row.publicId,
      owner_type: row.ownerType,
      owner_id: ownerPublicId(row),
      document_type: row.documentType,
      original_filename: row.originalFilename,
      content_type: row.contentType,
      size_bytes: row.sizeBytes,
      sha256: row.sha256,
      expires_on: row.expiresOn,
      retain_until: row.retainUntil,
      uploaded_by: uploaderPublicIds.get(row.uploadedBy)!,
      uploaded_at: row.uploadedAt,
    }));
  }
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
