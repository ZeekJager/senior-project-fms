import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long an appeal attachment link works. */
export const ATTACHMENT_URL_TTL_SECONDS = 15 * 60;

/**
 * HMAC-signed, time-limited links to an appeal attachment's bytes (FMS-159):
 * `/api/v1/appeal-attachments/{id}/content?expires=<unix seconds>&signature=<hex>`. Handed out only to the driver who
 * appealed and the appeal's reviewers, each time recorded on the appeal's timeline. The key is derived from JWT_SECRET
 * for this one purpose (as the document links', FMS-17), so neither signature can stand for the other.
 */
export class AttachmentUrlSigner {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHmac('sha256', secret).update('fms:appeal-attachment-url:v1').digest();
  }

  sign(attachmentId: string, ttlSeconds = ATTACHMENT_URL_TTL_SECONDS): { url: string; expiresAt: Date } {
    const expires = Math.floor(this.now() / 1000) + ttlSeconds;
    return {
      url: `/api/v1/appeal-attachments/${attachmentId}/content?expires=${expires}&signature=${this.signatureOf(attachmentId, expires)}`,
      expiresAt: new Date(expires * 1000),
    };
  }

  /** `ok`, `expired` (a valid link past its time) or `invalid` (anything else). */
  verify(attachmentId: string, expires: string | undefined, signature: string | undefined): 'ok' | 'expired' | 'invalid' {
    if (!expires || !/^\d{1,12}$/.test(expires) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return 'invalid';
    const expected = Buffer.from(this.signatureOf(attachmentId, Number(expires)), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return 'invalid';
    return Number(expires) * 1000 <= this.now() ? 'expired' : 'ok';
  }

  private signatureOf(attachmentId: string, expires: number): string {
    return createHmac('sha256', this.key).update(`${attachmentId}:${expires}`).digest('hex');
  }
}
