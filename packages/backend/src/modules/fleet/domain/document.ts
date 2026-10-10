import { AppError } from '../../../shared/errors/app-error';

/** Largest accepted upload (api-contract §8; also chk_document_size). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * What a document can belong to through this API. document.documents allows
 * more owner types (trip, maintenance_record, ...); their modules add them
 * with the read check for that owner.
 */
export const DOCUMENT_OWNER_TYPES = ['vehicle', 'driver'] as const;
export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];

/** As in chk_document_type. */
export const DOCUMENT_TYPES = [
  'registration',
  'licence',
  'insurance',
  'maintenance_invoice',
  'inspection_evidence',
  'incident_photo',
  'dvir_attachment',
  'fuel_receipt',
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type DocumentContentType = 'image/jpeg' | 'image/png' | 'application/pdf';

/**
 * The type of a file from its first bytes. The filename and the declared
 * Content-Type are the client's claim and are ignored: a .txt renamed .pdf
 * is still text. Null for anything that is not JPEG, PNG or PDF.
 */
export function sniffContentType(bytes: Buffer): DocumentContentType | null {
  const starts = (...sig: number[]) => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  return null;
}

/** The uploaded file's name, for display only: no path, no control characters, at most 255 characters. */
export function cleanFilename(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = raw.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name ? name.slice(0, 255) : null;
}

/** A document as the API returns it. The storage key is never part of it (api-contract §8). */
export interface DocumentView {
  id: string;
  owner_type: DocumentOwnerType;
  /** The vehicle's or driver's public id. */
  owner_id: string;
  document_type: DocumentType;
  original_filename: string | null;
  content_type: DocumentContentType;
  size_bytes: number;
  sha256: string;
  /** `YYYY-MM-DD`: the document's own expiry (a registration, licence, insurance). */
  expires_on: string | null;
  /** `YYYY-MM-DD`: keep the file at least until then, even once deleted. */
  retain_until: string | null;
  uploaded_by: string;
  uploaded_at: Date;
}

export const DOCUMENT_EVENTS = { uploaded: 'DocumentUploaded' } as const;

export const documentNotFound = () => new AppError(404, 'NOT_FOUND', 'Document not found.');

export const unsupportedMediaType = () =>
  new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG and PDF files are accepted.', [{ field: 'file', reason: 'unsupported_type' }]);

export const fileTooLarge = () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'The file is larger than 10 MB.');

/** The owner does not exist or the caller may not read it: the same answer. */
export const ownerNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The document owner does not exist.', [{ field: 'owner_id', reason: 'references_missing_record' }]);

export const linkExpired = () => new AppError(401, 'AUTH_TOKEN_EXPIRED', 'This document link has expired. Ask for a new one.');
export const linkInvalid = () => new AppError(401, 'AUTH_TOKEN_INVALID', 'This document link is not valid.');
