import type { PoolClient } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DocumentOwnerType } from '../domain/document';
import type { ExpiryLevel, ExpirySubject } from '../domain/expiry';

/** A live document of an active vehicle or driver whose expiry date is within `window` days. */
export interface DueDocument {
  id: string;
  publicId: string;
  ownerType: DocumentOwnerType;
  ownerPublicId: string;
  documentType: string;
  expiresOn: string;
  daysLeft: number;
}

/** An active driver whose licence expires within `window` days. */
export interface DueLicence {
  id: string;
  publicId: string;
  userId: string;
  licenseExpiry: string;
  daysLeft: number;
}

/**
 * Expiry checks over document.documents and fleet.drivers, and the notices
 * already raised (fleet.expiry_notices). `today` is the operating day
 * (YYYY-MM-DD in Addis Ababa); days left are calendar days.
 */
export class ExpiryRepository {
  async documentsDue(db: Queryable, today: string, window: number, documentPublicId?: string): Promise<DueDocument[]> {
    const res = await db.query<DueDocument>(
      `SELECT d.id, d.public_id AS "publicId", d.owner_type AS "ownerType",
              COALESCE(v.public_id, dr.public_id) AS "ownerPublicId", d.document_type AS "documentType",
              d.expires_on::text AS "expiresOn", (d.expires_on - $1::date) AS "daysLeft"
         FROM document.documents d
         LEFT JOIN fleet.vehicles v ON d.owner_type = 'vehicle' AND v.id = d.owner_id
         LEFT JOIN fleet.drivers dr ON d.owner_type = 'driver' AND dr.id = d.owner_id
        WHERE d.deleted_at IS NULL
          AND d.expires_on BETWEEN $1::date AND $1::date + $2::int
          AND (v.is_active OR dr.is_active)
          AND ($3::uuid IS NULL OR d.public_id = $3::uuid)
        ORDER BY d.expires_on, d.id`,
      [today, window, documentPublicId ?? null],
    );
    return res.rows;
  }

  async licencesDue(db: Queryable, today: string, window: number): Promise<DueLicence[]> {
    const res = await db.query<DueLicence>(
      `SELECT d.id, d.public_id AS "publicId", d.user_id AS "userId",
              d.license_expiry::text AS "licenseExpiry", (d.license_expiry - $1::date) AS "daysLeft"
         FROM fleet.drivers d
        WHERE d.is_active AND d.license_expiry BETWEEN $1::date AND $1::date + $2::int
        ORDER BY d.license_expiry, d.id`,
      [today, window],
    );
    return res.rows;
  }

  /**
   * Records a notice unless that level was already raised for this subject
   * and expiry date. True when this call recorded it: only then is the
   * event published. Concurrent checks (two instances, the daily job and an
   * upload) race on the unique key, and exactly one wins.
   */
  async recordNotice(
    client: PoolClient,
    notice: { subject: ExpirySubject; subjectId: string; expiresOn: string; level: ExpiryLevel; daysLeft: number; correlationId: string },
  ): Promise<boolean> {
    const res = await client.query(
      `INSERT INTO fleet.expiry_notices (subject_type, subject_id, expires_on, level, days_left, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (subject_type, subject_id, expires_on, level) DO NOTHING
       RETURNING id`,
      [notice.subject, notice.subjectId, notice.expiresOn, notice.level, notice.daysLeft, notice.correlationId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
