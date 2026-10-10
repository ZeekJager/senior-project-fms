import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a document link works (api-contract §8, FMS-17). */
export const DOCUMENT_URL_TTL_SECONDS = 60 * 60;

/**
 * HMAC-signed, time-limited links to a document's bytes:
 * `/api/v1/documents/{id}/content?expires=<unix seconds>&signature=<hex>`.
 * Whoever holds the link can fetch the file until it expires, so it is
 * handed out only after the read check, and lives one hour.
 *
 * The key is derived from JWT_SECRET for this one purpose, so a link
 * signature can never be used as anything else, and rotating the JWT secret
 * also ends every outstanding link.
 */
export class DocumentUrlSigner {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHmac('sha256', secret).update('fms:document-url:v1').digest();
  }

  sign(documentId: string, ttlSeconds = DOCUMENT_URL_TTL_SECONDS): { url: string; expiresAt: Date } {
    const expires = Math.floor(this.now() / 1000) + ttlSeconds;
    const signature = this.signatureOf(documentId, expires);
    return {
      url: `/api/v1/documents/${documentId}/content?expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires * 1000),
    };
  }

  /** `ok`, `expired` (a valid link past its time) or `invalid` (anything else). */
  verify(documentId: string, expires: string | undefined, signature: string | undefined): 'ok' | 'expired' | 'invalid' {
    if (!expires || !/^\d{1,12}$/.test(expires) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return 'invalid';
    const expected = Buffer.from(this.signatureOf(documentId, Number(expires)), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return 'invalid';
    return Number(expires) * 1000 <= this.now() ? 'expired' : 'ok';
  }

  private signatureOf(documentId: string, expires: number): string {
    return createHmac('sha256', this.key).update(`${documentId}:${expires}`).digest('hex');
  }
}
