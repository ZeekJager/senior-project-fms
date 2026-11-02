import { createHmac, timingSafeEqual } from 'node:crypto';
import { BACKUP_LINK_TTL_SECONDS } from './backup';

/**
 * Signed, short-lived download links for a backup's file (FMS-144):
 * `/api/v1/system/backups/{id}/content?user=<public id>&expires=<unix seconds>&signature=<hex>`.
 * The link names the admin it was made for, so the download itself is audited
 * as theirs. As with document links (FMS-17) the key is derived from JWT_SECRET
 * for this one purpose: a document link's signature never opens a backup.
 */
export class BackupLinkSigner {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHmac('sha256', secret).update('fms:backup-url:v1').digest();
  }

  sign(backupId: string, userPublicId: string, ttlSeconds = BACKUP_LINK_TTL_SECONDS): { url: string; expiresAt: Date } {
    const expires = Math.floor(this.now() / 1000) + ttlSeconds;
    const signature = this.signatureOf(backupId, userPublicId, expires);
    return {
      url: `/api/v1/system/backups/${backupId}/content?user=${userPublicId}&expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires * 1000),
    };
  }

  /** `ok`, `expired` (a valid link past its time) or `invalid` (anything else). */
  verify(backupId: string, userPublicId: string | undefined, expires: string | undefined, signature: string | undefined): 'ok' | 'expired' | 'invalid' {
    if (!userPublicId || !expires || !/^\d{1,12}$/.test(expires) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return 'invalid';
    const expected = Buffer.from(this.signatureOf(backupId, userPublicId, Number(expires)), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return 'invalid';
    return Number(expires) * 1000 <= this.now() ? 'expired' : 'ok';
  }

  private signatureOf(backupId: string, userPublicId: string, expires: number): string {
    return createHmac('sha256', this.key).update(`${backupId}:${userPublicId}:${expires}`).digest('hex');
  }
}
