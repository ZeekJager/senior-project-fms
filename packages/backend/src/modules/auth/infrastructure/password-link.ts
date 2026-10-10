import { createHash, randomBytes } from 'node:crypto';

const LINK_BYTES = 32;

/** A new one-time password link: 256 random bits, URL-safe, and the hash that is stored. */
export function newPasswordLink(): { value: string; hash: string } {
  const value = randomBytes(LINK_BYTES).toString('base64url');
  return { value, hash: passwordLinkHash(value) };
}

/** What auth.password_tokens stores: the SHA-256 of the link, hex. The link itself is never stored. */
export function passwordLinkHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
